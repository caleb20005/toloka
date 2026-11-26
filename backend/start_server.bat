@echo off
set FORCE_POSTGRES=true
set PGHOST=localhost
set PGPORT=5432
set PGDATABASE=link_ai
set PGUSER=postgres
node server.js > output.log 2>&1
