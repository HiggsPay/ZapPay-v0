import { Hono } from "hono";
import { SUPPORTED_TOKENS } from "../tokenRegistry";

const app = new Hono();

app.get("/api/health", (c) => {
  const networks = [...new Set(SUPPORTED_TOKENS.filter(t => !t.isTestnet).map(t => t.chainName))];
  return c.json({
    status: "ok",
    message: "ZapPay server is running",
    config: {
      networks,
      facilitator: process.env.FACILITATOR_URL || "https://x402.org/facilitator",
    },
  });
});

app.get("/api/payment-options", (c) => {
  return c.json({
    options: [
      {
        name: "24-Hour Access",
        endpoint: "/api/pay/session",
        price: "$1.00",
        description: "Session ID valid for 24 hours of unlimited access",
      },
      {
        name: "One-Time Access",
        endpoint: "/api/pay/onetime",
        price: "$0.10",
        description: "Single-use payment for immediate access",
      },
    ],
  });
});

app.get("/api/payment-config/supported", (c) => {
  return c.json({ supported: SUPPORTED_TOKENS });
});

export default app;
