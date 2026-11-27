import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends EnvBindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

type EnvBindings = Env;
