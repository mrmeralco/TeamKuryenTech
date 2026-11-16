// Worker entry module (wrangler.jsonc "main"). The runtime treats every export of this module as an entrypoint,
// so it exports only the handlers; the routing and proxy logic live in app.js.
import { handlers } from "./app.js";

export default handlers;
