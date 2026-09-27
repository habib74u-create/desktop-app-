// src/native/nsevent_monitor.mm
#import <AppKit/AppKit.h>
#import <napi.h>

namespace {

class NSEventMonitor : public Napi::ObjectWrap<NSEventMonitor> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit NSEventMonitor(const Napi::CallbackInfo& info);
  ~NSEventMonitor();

 private:
  Napi::Value Start(const Napi::CallbackInfo& info);
  Napi::Value Stop(const Napi::CallbackInfo& info);

  id globalMonitor_ = nil;
  id localMonitor_ = nil;
  Napi::ThreadSafeFunction tsfn_;
  bool tsfnValid_ = false;
  bool consume_ = false;
};

Napi::Object NSEventMonitor::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "NSEventMonitor", {
    InstanceMethod("start", &NSEventMonitor::Start),
    InstanceMethod("stop", &NSEventMonitor::Stop),
  });
  exports.Set("NSEventMonitor", func);
  return exports;
}

NSEventMonitor::NSEventMonitor(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NSEventMonitor>(info) {}

NSEventMonitor::~NSEventMonitor() {
  if (globalMonitor_) [NSEvent removeMonitor:globalMonitor_];
  if (localMonitor_) [NSEvent removeMonitor:localMonitor_];
  if (tsfnValid_) tsfn_.Release();
}

Napi::Value NSEventMonitor::Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "callback required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() >= 2 && info[1].IsBoolean()) {
    consume_ = info[1].As<Napi::Boolean>().Value();
  }

  tsfn_ = Napi::ThreadSafeFunction::New(
      env, info[0].As<Napi::Function>(), "NSEventMonitor", 0, 1);
  tsfnValid_ = true;

  auto emit = [this](NSEvent* event) {
    if (!tsfnValid_) return;
    // Capture only what we need; NSEvent is not thread-safe
    std::string chars = "";
    NSString* s = [event charactersIgnoringModifiers];
    if (s) chars = std::string([s UTF8String] ?: "");

    unsigned short keyCode = event.keyCode;
    bool isDown = (event.type == NSEventTypeKeyDown);

    tsfn_.NonBlockingCall([chars, keyCode, isDown](
        Napi::Env env, Napi::Function cb) {
      Napi::Object payload = Napi::Object::New(env);
      payload.Set("keyCode", Napi::Number::New(env, keyCode));
      payload.Set("chars", Napi::String::New(env, chars));
      payload.Set("isDown", Napi::Boolean::New(env, isDown));
      cb.Call({payload});
    });
  };

  globalMonitor_ = [NSEvent addGlobalMonitorForEventsMatchingMask:
      (NSEventMaskKeyDown | NSEventMaskKeyUp)
      handler:^(NSEvent* event) { emit(event); }];

  localMonitor_ = [NSEvent addLocalMonitorForEventsMatchingMask:
      (NSEventMaskKeyDown | NSEventMaskKeyUp)
      handler:^NSEvent* (NSEvent* event) {
        emit(event);
        return consume_ ? nil : event;
      }];

  return env.Undefined();
}

Napi::Value NSEventMonitor::Stop(const Napi::CallbackInfo& info) {
  if (globalMonitor_) { [NSEvent removeMonitor:globalMonitor_]; globalMonitor_ = nil; }
  if (localMonitor_)  { [NSEvent removeMonitor:localMonitor_];  localMonitor_ = nil; }
  if (tsfnValid_)     { tsfn_.Release(); tsfnValid_ = false; }
  return info.Env().Undefined();
}

}  // namespace

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return NSEventMonitor::Init(env, exports);
}

NODE_API_MODULE(nsevent_monitor, InitAll)
