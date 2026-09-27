// src/native/audio_capture.mm
#import <CoreAudio/CoreAudio.h>
#import <AudioToolbox/AudioToolbox.h>
#import <napi.h>
#import <vector>
#import <mutex>

namespace {

constexpr int kSampleRate = 16000;
constexpr int kChannels = 1;
constexpr int kFramesPerCallback = 1600;  // 100ms at 16kHz

class AudioCapture : public Napi::ObjectWrap<AudioCapture> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit AudioCapture(const Napi::CallbackInfo& info);
  ~AudioCapture();

 private:
  Napi::Value Start(const Napi::CallbackInfo& info);
  Napi::Value Stop(const Napi::CallbackInfo& info);
  Napi::Value IsRunning(const Napi::CallbackInfo& info);

  static OSStatus onDefaultDeviceChanged(
      AudioObjectID inObjectID,
      UInt32 inNumberAddresses,
      const AudioObjectPropertyAddress* inAddresses,
      void* inClientData);

  AudioDeviceID deviceId_ = kAudioObjectUnknown;
  AudioUnit audioUnit_ = nullptr;
  bool running_ = false;

  Napi::ThreadSafeFunction tsfn_;
  bool tsfnValid_ = false;

  std::mutex mutex_;
  std::vector<float> scratch_;
};

Napi::Object AudioCapture::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "AudioCapture", {
    InstanceMethod("start", &AudioCapture::Start),
    InstanceMethod("stop", &AudioCapture::Stop),
    InstanceMethod("isRunning", &AudioCapture::IsRunning),
  });
  exports.Set("AudioCapture", func);
  return exports;
}

AudioCapture::AudioCapture(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<AudioCapture>(info) {
  scratch_.resize(kFramesPerCallback);
}

AudioCapture::~AudioCapture() {
  if (running_) {
    AudioOutputUnitStop(audioUnit_);
    AudioUnitUninitialize(audioUnit_);
    AudioComponentInstanceDispose(audioUnit_);
  }
  if (tsfnValid_) tsfn_.Release();
}

// Called when the system default input device changes
OSStatus AudioCapture::onDefaultDeviceChanged(
    AudioObjectID inObjectID,
    UInt32 inNumberAddresses,
    const AudioObjectPropertyAddress* inAddresses,
    void* inClientData) {
  auto* self = static_cast<AudioCapture*>(inClientData);
  // Just log via the JS callback; the caller can restart capture
  if (self->tsfnValid_) {
    self->tsfn_.NonBlockingCall([](Napi::Env env, Napi::Function cb) {
      cb.Call({Napi::String::New(env, "deviceChanged")});
    });
  }
  return noErr;
}

Napi::Value AudioCapture::Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "callback required").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Get default input device
  AudioObjectPropertyAddress addr = {
      kAudioHardwarePropertyDefaultInputDevice,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMaster};
  UInt32 size = sizeof(AudioDeviceID);
  OSStatus err = AudioObjectGetPropertyData(
      kAudioObjectSystemObject, &addr, 0, nullptr, &size, &deviceId_);
  if (err != noErr) {
    Napi::Error::New(env, "No default input device").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Register listener for default device changes [citation:3][citation:8]
  err = AudioObjectAddPropertyListener(
      kAudioObjectSystemObject, &addr, onDefaultDeviceChanged, this);
  // Not fatal if this fails

  tsfn_ = Napi::ThreadSafeFunction::New(
      env, info[0].As<Napi::Function>(), "AudioCapture", 0, 1);
  tsfnValid_ = true;

  // Set up the AudioUnit for capture
  AudioComponentDescription desc = {};
  desc.componentType = kAudioUnitType_Output;
  desc.componentSubType = kAudioUnitSubType_VoiceProcessingIO;
  desc.componentManufacturer = kAudioUnitManufacturer_Apple;

  AudioComponent comp = AudioComponentFindNext(nullptr, &desc);
  if (!comp) {
    Napi::Error::New(env, "AudioComponent not found").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  AudioComponentInstanceNew(comp, &audioUnit_);

  // Enable input
  UInt32 enable = 1;
  AudioUnitSetProperty(audioUnit_,
      kAudioOutputUnitProperty_EnableIO,
      kAudioUnitScope_Input, 1, &enable, sizeof(enable));

  // Set stream format: 16kHz mono float32
  AudioStreamBasicDescription format = {};
  format.mSampleRate = kSampleRate;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
  format.mFramesPerPacket = 1;
  format.mChannelsPerFrame = kChannels;
  format.mBitsPerChannel = 32;
  format.mBytesPerFrame = 4;
  format.mBytesPerPacket = 4;
  AudioUnitSetProperty(audioUnit_,
      kAudioUnitProperty_StreamFormat,
      kAudioUnitScope_Output, 1, &format, sizeof(format));

  // Input callback
  AURenderCallbackStruct callback = {};
  callback.inputProc = [](void* inRefCon, AudioUnitRenderActionFlags* ioActionFlags,
      const AudioTimeStamp* inTimeStamp, UInt32 inBusNumber,
      UInt32 inNumberFrames, AudioBufferList* ioData) -> OSStatus {
    auto* self = static_cast<AudioCapture*>(inRefCon);

    if (!self->tsfnValid_) return noErr;

    std::vector<float> samples(inNumberFrames);
    AudioBufferList bufList;
    bufList.mNumberBuffers = 1;
    bufList.mBuffers[0].mNumberChannels = kChannels;
    bufList.mBuffers[0].mDataByteSize = inNumberFrames * sizeof(float);
    bufList.mBuffers[0].mData = samples.data();

    OSStatus err = AudioUnitRender(self->audioUnit_, ioActionFlags, inTimeStamp,
                                   1, inNumberFrames, &bufList);
    if (err != noErr) return err;

    // Marshal to JS — copy into a heap buffer
    auto* heap = new float[samples.size()];
    std::memcpy(heap, samples.data(), samples.size() * sizeof(float));
    size_t count = samples.size();

    self->tsfn_.NonBlockingCall([heap, count](Napi::Env env, Napi::Function cb) {
      auto arr = Napi::Float32Array::New(env, count);
      std::memcpy(arr.Data(), heap, count * sizeof(float));
      delete[] heap;
      cb.Call({arr});
    });

    return noErr;
  };
  callback.inputProcRefCon = this;

  AudioUnitSetProperty(audioUnit_,
      kAudioOutputUnitProperty_SetInputCallback,
      kAudioUnitScope_Global, 0, &callback, sizeof(callback));

  AudioUnitInitialize(audioUnit_);
  AudioOutputUnitStart(audioUnit_);
  running_ = true;

  return env.Undefined();
}

Napi::Value AudioCapture::Stop(const Napi::CallbackInfo& info) {
  if (running_) {
    AudioOutputUnitStop(audioUnit_);
    AudioUnitUninitialize(audioUnit_);
    AudioComponentInstanceDispose(audioUnit_);
    audioUnit_ = nullptr;
    running_ = false;
  }

  AudioObjectPropertyAddress addr = {
      kAudioHardwarePropertyDefaultInputDevice,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMaster};
  AudioObjectRemovePropertyListener(
      kAudioObjectSystemObject, &addr, onDefaultDeviceChanged, this);

  if (tsfnValid_) {
    tsfn_.Release();
    tsfnValid_ = false;
  }

  return info.Env().Undefined();
}

Napi::Value AudioCapture::IsRunning(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), running_);
}

}  // namespace

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return AudioCapture::Init(env, exports);
}

NODE_API_MODULE(audio_capture, InitAll)
