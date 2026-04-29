import { Hono } from "hono";

const app = new Hono();

interface Session {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  type: "24hour" | "onetime";
  used?: boolean;
}

// In-memory session store — replace with Redis in production
export const sessions = new Map<string, Session>();

app.get("/api/session/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ valid: false, error: "Session not found" }, 404);

  const now = new Date();
  const expired = now > session.expiresAt;
  const used = session.type === "onetime" && session.used;

  if (expired || used) {
    return c.json({
      valid: false,
      error: expired ? "Session expired" : "One-time access already used",
      session: { id: session.id, type: session.type },
    });
  }

  if (session.type === "onetime") {
    session.used = true;
    sessions.set(sessionId, session);
  }

  return c.json({
    valid: true,
    session: {
      id: session.id,
      type: session.type,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      remainingTime: session.expiresAt.getTime() - now.getTime(),
    },
  });
});

app.get("/api/sessions", (c) => {
  const active = Array.from(sessions.values())
    .filter(s => new Date() <= s.expiresAt && !(s.type === "onetime" && s.used))
    .map(s => ({ id: s.id, type: s.type, expiresAt: s.expiresAt.toISOString() }));
  return c.json({ sessions: active });
});

export default app;
