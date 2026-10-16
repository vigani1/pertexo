#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

static void fail(const char *reason) { perror(reason); _exit(126); }
static long number(const char *text, long min, long max) {
  char *end; errno = 0; long value = strtol(text, &end, 10);
  if (errno || !*text || *end || value < min || value > max) { errno=EINVAL; fail("Invalid launch limit"); }
  return value;
}
static void limit(int resource, rlim_t value) {
  struct rlimit limits = {value, value};
  if (setrlimit(resource, &limits)) fail("Set run limit");
}
#define ALLOW(name) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_##name, 0, 1), BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW)
#define DENY BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|ENOSYS)
#define OPEN_FLAGS (O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND|020000000)
#define ARG(n) (offsetof(struct seccomp_data,args)+(n)*sizeof(uint64_t))
#define READ_OPEN(name,n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_##name,0,4), BPF_STMT(BPF_LD|BPF_W|BPF_ABS,ARG(n)), BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,OPEN_FLAGS,0,1), DENY, BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
static void restrict_calls(void) {
#if defined(__aarch64__)
#define ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define ARCH AUDIT_ARCH_X86_64
#else
#error Unsupported runner architecture
#endif
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,ARCH,1,0),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#ifdef __NR_open
    READ_OPEN(open,1),
#endif
    READ_OPEN(openat,2),
    // Shared writable mappings bypass RLIMIT_DATA; tasks have no shared memory.
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_mmap,0,4),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,ARG(3)),
    BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,MAP_SHARED,0,1),
    DENY,
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_clone,0,4),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,ARG(0)),
    BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,CLONE_THREAD,1,0),
    DENY,
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
    // Only flags needed for existing private event/stdio descriptors.
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_fcntl,0,8),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,ARG(1)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,F_GETFL,5,0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,F_SETFL,4,0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,F_GETFD,3,0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,F_SETFD,2,0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,F_DUPFD_CLOEXEC,1,0),
    DENY,
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_ioctl,0,7),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,ARG(1)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,FIONREAD,4,0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,FIONBIO,3,0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,TCGETS,2,0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,TIOCGWINSZ,1,0),
    DENY,
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
    ALLOW(read), ALLOW(write), ALLOW(readv), ALLOW(writev), ALLOW(pread64),
    ALLOW(close), ALLOW(close_range), ALLOW(fstat), ALLOW(newfstatat), ALLOW(statx),
#ifdef __NR_stat
    ALLOW(stat), ALLOW(lstat),
#endif
    ALLOW(statfs), ALLOW(fstatfs), ALLOW(readlinkat),
#ifdef __NR_readlink
    ALLOW(readlink),
#endif
#ifdef __NR_access
    ALLOW(access),
#endif
    ALLOW(faccessat), ALLOW(faccessat2), ALLOW(getdents64), ALLOW(getcwd), ALLOW(lseek),
    ALLOW(dup), ALLOW(dup3), ALLOW(pipe2), ALLOW(eventfd2),
#ifdef __NR_dup2
    ALLOW(dup2), ALLOW(pipe),
#endif
    ALLOW(epoll_create1), ALLOW(epoll_ctl), ALLOW(epoll_pwait), ALLOW(epoll_pwait2),
#ifdef __NR_epoll_wait
    ALLOW(epoll_create), ALLOW(epoll_wait), ALLOW(poll), ALLOW(select),
#endif
    ALLOW(ppoll), ALLOW(pselect6), ALLOW(brk), ALLOW(mmap), ALLOW(mprotect),
    ALLOW(munmap), ALLOW(mremap), ALLOW(madvise),
    ALLOW(rt_sigaction), ALLOW(rt_sigprocmask), ALLOW(rt_sigreturn),
    ALLOW(rt_sigtimedwait), ALLOW(rt_sigsuspend), ALLOW(sigaltstack),
    ALLOW(kill), ALLOW(tkill), ALLOW(tgkill),
    ALLOW(getpid), ALLOW(getppid), ALLOW(gettid), ALLOW(getuid), ALLOW(geteuid),
    ALLOW(getgid), ALLOW(getegid), ALLOW(getgroups), ALLOW(getrandom),
    ALLOW(clock_gettime), ALLOW(clock_getres), ALLOW(clock_nanosleep), ALLOW(nanosleep),
    ALLOW(gettimeofday), ALLOW(getrusage), ALLOW(getrlimit), ALLOW(prlimit64),
#ifdef __NR_time
    ALLOW(time), ALLOW(arch_prctl),
#endif
    ALLOW(set_tid_address), ALLOW(set_robust_list), ALLOW(rseq), ALLOW(futex),
    ALLOW(sched_getaffinity), ALLOW(sched_yield), ALLOW(sched_getparam),
    ALLOW(sched_getscheduler), ALLOW(uname), ALLOW(sysinfo), ALLOW(restart_syscall),
    ALLOW(getsockname), ALLOW(getpeername), ALLOW(getsockopt),
    ALLOW(execve), ALLOW(execveat), ALLOW(exit), ALLOW(exit_group),
    DENY,
  };
  struct sock_fprog program = {sizeof(filter)/sizeof(filter[0]), filter};
  if (prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0) || prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program)) fail("Install run syscall filter");
}
int main(int argc, char **argv) {
  if (argc < 5 || getuid()!=0 || geteuid()!=0) { errno=EPERM; fail("Privileged launcher required"); }
  uid_t uid = (uid_t)number(argv[1],20000,20015);
  long memory = number(argv[2],32,1024), seconds = number(argv[3],1,300);
  pid_t parent = getppid();
  int score = open("/proc/self/oom_score_adj",O_WRONLY|O_CLOEXEC);
  if (score<0 || write(score,"1000",4)!=4) fail("Set task OOM priority");
  close(score);
  limit(RLIMIT_CORE,0); limit(RLIMIT_NOFILE,64); limit(RLIMIT_NPROC,16);
  limit(RLIMIT_CPU,(rlim_t)seconds+1); limit(RLIMIT_STACK,8*1024*1024);
  limit(RLIMIT_DATA,((rlim_t)memory+384)*1024*1024);
  limit(RLIMIT_AS,((rlim_t)4096+2*(rlim_t)memory)*1024*1024);
  if (setgroups(0,NULL) || setresgid(uid,uid,uid) || setresuid(uid,uid,uid)) fail("Drop task identity");
  struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3,0};
  struct __user_cap_data_struct caps[2] = {{0},{0}};
  if (syscall(SYS_capset,&header,caps)) fail("Drop task capabilities");
  if (prctl(PR_SET_PDEATHSIG,SIGKILL) || getppid()!=parent) fail("Set task parent fence");
  if (syscall(SYS_close_range,4,~0u,0)) fail("Close inherited descriptors");
  restrict_calls();
  execv(argv[4],argv+4); fail("Start task process");
}
