process.env.BITSENTRY_DESKTOP_SMOKE_SCENARIO = "runbook";

if (process.argv.includes("--packaged")) {
  process.env.BITSENTRY_DESKTOP_SMOKE_REQUIRE_PACKAGED = "1";
}

require("./smoke-test");
