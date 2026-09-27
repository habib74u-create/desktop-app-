// src/native/fn_key_monitor.mm
#import <AppKit/AppKit.h>
#import <napi.h>
#import <functional>
#import <memory>

namespace {

constexpr unsigned short kFnKeyCode = 63;

class FnKeyMonitor : public Napi::ObjectWrap<FnKeyMonitor> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit FnKeyMonitor(const Napi::CallbackInfo& info);
  ~FnKeyMonitor();

 private:
  Napi::Value Start(const Napi::CallbackInfo& info);
  Napi::Value Stop(const Napi::CallbackInfo& info);

  id globalMonitor_ = nil;
  id localMonitor_ = nil;
  bool fnPressed_ = false;
  Napi::ThreadSafeFunction tsfn_;
  bool tsfnValid_ = false;
};

Napi::Object FnKeyMonitor::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "FnKeyMonitor", {
    InstanceMethod("start", &FnKeyMonitor::Start),
    InstanceMethod("stop", &FnKeyMonitor::Stop),
  });
  exports.Set("FnKeyMonitor", func);
  return exports;
}

FnKeyMonitor::FnKeyMonitor(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<FnKeyMonitor>(info) {}

FnKeyMonitor::~FnKeyMonitor() {
  if (globalMonitor_) [NSEvent removeMonitor:globalMonitor_];
  if (localMonitor_) [NSEvent removeMonitor:localMonitor_];
  if (tsfnValid_) tsfn_.Release();
}

Napi::Value FnKeyMonitor::Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "callback required").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // ThreadSafeFunction so the block can call back into JS
  tsfn_ = Napi::ThreadSafeFunction::New(
      env,
      info[0].As<Napi::Function>(),
      "FnKeyMonitor",
      0,
      1);
  tsfnValid_ = true;

  auto emit = [this](bool down) {
    if (!tsfnValid_) return;
    // Capture down by value; the TSFN will marshal to the JS thread
    bool d = down;
    tsfn_.NonBlockingCall([d](Napi::Env env, Napi::Function jsCallback) {
      jsCallback.Call({Napi::Boolean::New(env, d)});
    });
  };

  // Global monitor: sees Fn presses anywhere in the system
  globalMonitor_ = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskFlagsChanged
                                                          handler:^(NSEvent* event) {
    if (event.keyCode != kFnKeyCode) return;

    BOOL fnDown = (event.modifierFlags & NSEventModifierFlagFunction) != 0;
    if (fnDown == fnPressed_) return;   // debounce duplicate flagsChanged
    fnPressed_ = fnDown;
    emit(fnDown);
  }];

  // Local monitor: sees Fn presses while Jarvis is focused
  // (global monitor doesn't fire while our own app is active)
  localMonitor_ = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskFlagsChanged
                                                         handler:^NSEvent* (NSEvent* event) {
    if (event.keyCode != kFnKeyCode) return event;

    BOOL fnDown = (event.modifierFlags & NSEventModifierFlagFunction) != 0;
    if (fnDown != fnPressed_) {
      fnPressed_ = fnDown;
      emit(fnDown);
    }
    return event;
  }];

  return env.Undefined();
}

Napi::Value FnKeyMonitor::Stop(const Napi::CallbackInfo& info) {
  if (globalMonitor_) {
    [NSEvent removeMonitor:globalMonitor_];
    globalMonitor_ = nil;
  }
  if (localMonitor_) {
    [NSEvent removeMonitor:localMonitor_];
    localMonitor_ = nil;
  }
  if (tsfnValid_) {
    tsfn_.Release();
    tsfnValid_ = false;
  }
  fnPressed_ = false;
  return info.Env().Undefined();
}

}  // namespace

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return FnKeyMonitor::Init(env, exports);
}

NODE_API_MODULE(jarvis_native, InitAll)
