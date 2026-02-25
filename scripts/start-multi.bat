@echo off
REM Start two Pando nodes on localhost for development/testing.
REM Node 1: P2P 5001, API 5100, data ~/.pando-node1
REM Node 2: P2P 5002, API 5200, data ~/.pando-node2
REM
REM Usage:
REM   scripts\start-multi.bat            - start both nodes (keep running)
REM   scripts\start-multi.bat --test     - start, verify P2P, exit
REM   scripts\start-multi.bat --fresh    - wipe data dirs first

cd /d "%~dp0.."
node scripts/launch-nodes.js %*
