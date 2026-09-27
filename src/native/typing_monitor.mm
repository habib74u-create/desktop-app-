// src/native/typing_monitor.mm
#import <AppKit/AppKit.h>
#import <napi.h>
#import <chrono>

namespace {

class TypingMonitor : public Napi::ObjectWrap<TypingMonitor> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit TypingMonitor(const Napi::CallbackInfo& info);
  ~TypingMonitor();

 private:
  Napi::Value Start(const Napi::CallbackInfo& info);
  Napi::Value Stop(const Napi::CallbackInfo& info);
  Napi::Value IsTyping(const Napi::CallbackInfo& info);

  void onKey();

  id globalMonitor_ = nil;
  id localMonitor_ = nil;
  Napi::ThreadSafeFunction tsfn_;
  bool tsfnValid_ = false;

  // Typing state: any keypress resets the timer. We emit "typing" once,
  // then "idle" after kIdleMs of silence.
  std::chrono::steady_clock::time_point lastKeyAt_;
  bool typing_ = false;
  static constexpr int kIdleMs = 1500;
};

Napi::Object TypingMonitor::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "TypingMonitor", {
    InstanceMethod("start", &TypingMonitor::Start),
    InstanceMethod("stop", &TypingMonitor::Stop),
    InstanceMethod("isTyping", &TypingMonitor::IsTyping),
  });
  exports.Set("TypingMonitor", func);
  return exports;
}

TypingMonitor::TypingMonitor(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<TypingMonitor>(info) {}

TypingMonitor::~TypingMonitor() {
  if (globalMonitor_) [NSEvent removeMonitor:globalMonitor_];
  if (localMonitor_) [NSEvent removeMonitor:localMonitor_];
  if (tsfnValid_) tsfn_.Release();
}

void TypingMonitor::onKey() {
  lastKeyAt_ = std::chrono::steady_clock::now();

  if (!typing_) {
    typing_ = true;
    if (tsfnValid_) {
      tsfn_.NonBlockingCall([](Napi::Env env, Napi::Function cb) {
        cb.Call({Napi::String::New(env, "typing")});
      });
    }
  }

  // Schedule the idle transition
  if (tsfnValid_) {
    tsfn_.NonBlockingCall([](Napi::Env env, Napi::Function cb) {
      // The JS side handles the idle timer; we just nudge it
      cb.Call({Napi::String::New(env, "activity")});
    });
  }
}

Napi::Value TypingMonitor::Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "callback required").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  tsfn_ = Napi::ThreadSafeFunction::New(
      env, info[0].As<Napi::Function>(), "TypingMonitor", 0, 1);
  tsfnValid_ = true;

  auto handler = ^(NSEvent* event) {
    // Only count "typing" keys: printable chars, Delete, Return
    NSString* chars = [event characters];
    if (chars.length == 0) return;

    unichar c = [chars characterAtIndex:0];
    // Ignore modifier-only and control characters (except Delete/Return)
    if (c < 0x20 && c != 0x7F && c != 0x0D) return;

    this->onKey();
  };

  globalMonitor_ = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                          handler:handler];
  localMonitor_ = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                         handler:^NSEvent* (NSEvent* event) {
    handler(event);
    return event;
  }];

  return env.Undefined();
}

Napi::Value TypingMonitor::Stop(const Napi::CallbackInfo& info) {
  if (globalMonitor_) { [NSEvent removeMonitor:globalMonitor_]; globalMonitor_ = nil; }
  if (localMonitor_)  { [NSEvent removeMonitor:localMonitor_];  localMonitor_ = nil; }
  if (tsfnValid_)     { tsfn_.Release(); tsfnValid_ = false; }
  typing_ = false;
  return info.Env().Undefined();
}

Napi::Value TypingMonitor::IsTyping(const Napi::CallbackInfo& info) {
  auto now = std::chrono::steady_clock::now();
  auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      now - lastKeyAt_).count();
  return Napi::Boolean::New(info.Env(), elapsed < kIdleMs);
}

}  // namespace

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return TypingMonitor::Init(env, exports);
}

NODE_API_MODULE(typing_monitor, InitAll)
