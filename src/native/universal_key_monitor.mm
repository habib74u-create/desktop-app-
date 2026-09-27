// src/native/universal_key_monitor.mm
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <napi.h>
#import <vector>

namespace {

class UniversalKeyMonitor : public Napi::ObjectWrap<UniversalKeyMonitor> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit UniversalKeyMonitor(const Napi::CallbackInfo& info);
  ~UniversalKeyMonitor();

 private:
  Napi::Value Start(const Napi::CallbackInfo& info);
  Napi::Value Stop(const Napi::CallbackInfo& info);
  Napi::Value SetConsume(const Napi::CallbackInfo& info);

  static CGEventRef eventCallback(
      CGEventTapProxy proxy,
      CGEventType type,
      CGEventRef event,
      void* refcon);

  CFMachPortRef eventTap_ = nullptr;
  CFRunLoopSourceRef runLoopSource_ = nullptr;
  Napi::ThreadSafeFunction tsfn_;
  bool tsfnValid_ = false;
  bool consume_ = false;
};

Napi::Object UniversalKeyMonitor::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "UniversalKeyMonitor", {
    InstanceMethod("start", &UniversalKeyMonitor::Start),
    InstanceMethod("stop", &UniversalKeyMonitor::Stop),
    InstanceMethod("setConsume", &UniversalKeyMonitor::SetConsume),
  });
  exports.Set("UniversalKeyMonitor", func);
  return exports;
}

UniversalKeyMonitor::UniversalKeyMonitor(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<UniversalKeyMonitor>(info) {}

UniversalKeyMonitor::~UniversalKeyMonitor() {
  if (eventTap_) {
    CGEventTapEnable(eventTap_, false);
    CFRelease(eventTap_);
  }
  if (runLoopSource_) CFRelease(runLoopSource_);
  if (tsfnValid_) tsfn_.Release();
}

CGEventRef UniversalKeyMonitor::eventCallback(
    CGEventTapProxy proxy,
    CGEventType type,
    CGEventRef event,
    void* refcon) {
  auto* self = static_cast<UniversalKeyMonitor*>(refcon);

  if (!self->tsfnValid_) return event;

  // If the tap is disabled by the system (timeout, user input), re-enable it
  if (type == kCGEventTapDisabledByTimeout ||
      type == kCGEventTapDisabledByUserInput) {
    if (self->eventTap_) CGEventTapEnable(self->eventTap_, true);
    return event;
  }

  if (type != kCGEventKeyDown && type != kCGEventKeyUp) {
    return event;
  }

  CGKeyCode keyCode = (CGKeyCode)CGEventGetIntegerValueField(
      event, kCGKeyboardEventKeycode);
  bool isDown = (type == kCGEventKeyDown);

  self->tsfn_.NonBlockingCall([keyCode, isDown](
      Napi::Env env, Napi::Function cb) {
    Napi::Object payload = Napi::Object::New(env);
    payload.Set("keyCode", Napi::Number::New(env, keyCode));
    payload.Set("isDown", Napi::Boolean::New(env, isDown));
    cb.Call({payload});
  });

  // Consume the event if configured (blocks it from reaching other apps)
  return self->consume_ ? nullptr : event;
}

Napi::Value UniversalKeyMonitor::Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "callback required").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  tsfn_ = Napi::ThreadSafeFunction::New(
      env, info[0].As<Napi::Function>(), "UniversalKeyMonitor", 0, 1);
  tsfnValid_ = true;

  CGEventMask mask = (1 << kCGEventKeyDown) | (1 << kCGEventKeyUp);

  eventTap_ = CGEventTapCreate(
      kCGSessionEventTap,           // session-level tap
      kCGHeadInsertEventTap,        // insert at head so we see events first
      kCGEventTapOptionDefault,     // active tap (can modify/consume)
      mask,
      &UniversalKeyMonitor::eventCallback,
      this);

  if (!eventTap_) {
    Napi::Error::New(env,
        "CGEventTapCreate failed — grant Input Monitoring permission")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  runLoopSource_ = CFMachPortCreateRunLoopSource(
      kCFAllocatorDefault, eventTap_, 0);
  CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource_, kCFRunLoopCommonModes);
  CGEventTapEnable(eventTap_, true);

  return env.Undefined();
}

Napi::Value UniversalKeyMonitor::Stop(const Napi::CallbackInfo& info) {
  if (eventTap_) {
    CGEventTapEnable(eventTap_, false);
    CFRelease(eventTap_);
    eventTap_ = nullptr;
  }
  if (runLoopSource_) {
    CFRunLoopRemoveSource(CFRunLoopGetCurrent(), runLoopSource_, kCFRunLoopCommonModes);
    CFRelease(runLoopSource_);
    runLoopSource_ = nullptr;
  }
  if (tsfnValid_) {
    tsfn_.Release();
    tsfnValid_ = false;
  }
  return info.Env().Undefined();
}

Napi::Value UniversalKeyMonitor::SetConsume(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsBoolean()) {
    Napi::TypeError::New(info.Env(), "boolean required").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  consume_ = info[0].As<Napi::Boolean>().Value();
  return info.Env().Undefined();
}

}  // namespace

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return UniversalKeyMonitor::Init(env, exports);
}

NODE_API_MODULE(universal_key_monitor, InitAll)
