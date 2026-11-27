import { ai, blitzapi, firecrawl, flowbound } from "flowbound"
import { demo, samples } from "./plugins/demo.ts"

export default process.env.FLOWBOUND_DEMO === "1"
  ? demo()
  : flowbound({ changes: { directory: "hosted" }, providers: [blitzapi(), firecrawl(), ai(), samples()] })
