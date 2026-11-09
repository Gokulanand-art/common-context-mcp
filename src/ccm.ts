#!/usr/bin/env node
import { runCLI } from "./cli.js";

// Short command. Bare `ccm` onboards (login, then set up all agents);
// anything unknown prints usage instead of starting the server.
runCLI({ prog: "ccm", bare: "onboard", unknown: "usage", argv: process.argv.slice(2) });
