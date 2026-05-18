// Pebble Sports Worker — entry point.
//
// Two handlers:
//   fetch()     — handles HTTP requests from the watch app's pkjs
//                 (game polling, registration, settings page).
//   scheduled() — runs every 2 minutes via Cron Trigger, pushes
//                 timeline pins to Rebble for every registered user
//                 regardless of whether their watch app is open.
//
// The scheduled handler is what makes "passive updates" work — pins
// arrive on the watch timeline without the user opening the app.

import type { Env } from "./types";
import { handleHTTP } from "./routes";
import { runScheduledTick } from "./pin";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleHTTP(request, env, ctx);
    } catch (err) {
      console.error("[worker] unhandled fetch error:", err);
      return new Response(
        JSON.stringify({ error: "internal error" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // ctx.waitUntil keeps the worker alive across the full ESPN +
    // Rebble round-trip even though scheduled() itself returns when
    // the synchronous body finishes.
    ctx.waitUntil(runScheduledTick(env));
  },
};
