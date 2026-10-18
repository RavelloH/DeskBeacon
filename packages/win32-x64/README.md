# @deskbeacon/win32-x64

The Windows X64 C process supervision helper for [DeskBeacon](https://github.com/RavelloH/DeskBeacon).

This package is intended to be installed automatically as an optional dependency of `deskbeacon`. npm filters the package by `os: win32` and `cpu: x64`.

It contains `deskbeacon-job.exe`, a native Win32 Job Object launcher used to terminate complete child process trees on timeout, explicit cancellation or an unexpected Runtime exit. The executable is built using LLVM-mingw and requires no .NET runtime.

Run `npx deskbeacon` or `deskbeacon` instead of invoking the helper directly.
