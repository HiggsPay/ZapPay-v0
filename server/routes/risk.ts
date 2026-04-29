import { Hono } from "hono";

const app = new Hono();

app.get("/api/risk/wallet/:address", async (c) => {
  const address = c.req.param("address");
  const ANALYSIS_ENGINE_URL = process.env.ANALYSIS_ENGINE_URL || "http://localhost:3002";
  try {
    const response = await fetch(`${ANALYSIS_ENGINE_URL}/api/risk/wallet/${address}`);
    const data = await response.json();
    return c.json(data);
  } catch (error: any) {
    return c.json({ success: false, error: "Failed to fetch wallet risk analysis" }, 500);
  }
});

export default app;
