/* Test stand-in for an `opencode` process: ignores its arguments and sleeps STUB_SECONDS (default 20).
   Compiled as a binary named "opencode" so that `ps` reports comm=opencode and /proc/<pid>/cmdline holds the exact argv. */
#include <stdlib.h>
#include <unistd.h>
int main(void) { const char *s = getenv("STUB_SECONDS"); sleep(s ? atoi(s) : 20); return 0; }
