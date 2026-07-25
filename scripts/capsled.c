// capsled — set the caps-lock state (and with it the keyboard LED).
// Usage: capsled on|off
// Build (universal):
//   cc -arch arm64 -arch x86_64 -O2 -framework IOKit -o src/assets/bin/capsled scripts/capsled.c
#include <IOKit/IOKitLib.h>
#include <IOKit/hidsystem/IOHIDLib.h>
#include <IOKit/hidsystem/IOHIDParameter.h>
#include <stdbool.h>
#include <string.h>

int main(int argc, char **argv) {
  bool on = argc > 1 && strcmp(argv[1], "on") == 0;
  io_service_t svc = IOServiceGetMatchingService(kIOMasterPortDefault,
                                                 IOServiceMatching(kIOHIDSystemClass));
  if (!svc) return 1;
  io_connect_t conn = 0;
  if (IOServiceOpen(svc, mach_task_self(), kIOHIDParamConnectType, &conn) != KERN_SUCCESS)
    return 1;
  kern_return_t kr = IOHIDSetModifierLockState(conn, kIOHIDCapsLockState, on);
  IOServiceClose(conn);
  return kr == KERN_SUCCESS ? 0 : 1;
}
