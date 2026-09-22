@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Rebuild Windows PowerShell's defaults if CMD inherited PowerShell 7 module paths.
set "PSModulePath="
rem Use the built-in 64-bit Windows PowerShell even when called from 32-bit CMD.
set "NEXA_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "NEXA_POWERSHELL=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%NEXA_POWERSHELL%" (
    >&2 echo ERROR: Windows PowerShell 5.1 is required to run Nexa.
    exit /b 1
)
rem Keep the caller's quoted arguments and return the script's exit code.
"%NEXA_POWERSHELL%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0test-process-ownership.ps1" %*
exit /b %errorlevel%
