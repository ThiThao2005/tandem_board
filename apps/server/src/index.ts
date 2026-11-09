import { config } from "./config";
import { createServer } from "./server";

createServer().listen(config.port, () => {
  console.log(`Tandem API + realtime listening on http://localhost:${config.port}`);
});
