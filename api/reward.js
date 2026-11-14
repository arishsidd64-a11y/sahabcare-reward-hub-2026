
const crypto = require("crypto");

const ZONE_ID = "12244637";

function verifyTelegram(initData) {
  const token = process.env.BOT_TOKEN;
  if (!token || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) ||
      !authDate || Date.now() / 1000 - authDate > 86400 ||
      authDate > Date.now() / 1000 + 60) return null;

  params.delete("hash");

  const data = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData")
    .update(token).digest();

  const calculated = crypto.createHmac("sha256", secretKey)
    .update(data).digest("hex");

  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(calculated, "hex");

  if (a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)) return null;

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

async function redis(command) {
  const response = await fetch(process.env.KV_REST_API_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.KV_REST_API_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error("Redis operation failed");
  }
  return data.result;
}

module.exports = async (req, res) => {
  try {
    if (!process.env.KV_REST_API_URL ||
        !process.env.KV_REST_API_TOKEN) {
      return res.status(500).send("Database configuration missing");
    }

    // Monetag server-to-server postback
    if (req.method === "GET") {
      const {
        secret, ymid, event_type,
        reward_event_type, telegram_id, zone_id
      } = req.query;

      if (!process.env.POSTBACK_SECRET ||
          secret !== process.env.POSTBACK_SECRET) {
        return res.status(403).send("Invalid secret");
      }

      if (zone_id !== ZONE_ID ||
          !ymid || !/^[a-f0-9-]{36}$/i.test(ymid) ||
          !telegram_id || !/^\d+$/.test(String(telegram_id)) ||
          !["impression", "click"].includes(event_type)) {
        return res.status(400).send("Invalid postback data");
      }

      if (reward_event_type !== "valued") {
        return res.status(200).send("No reward");
      }

      const script = `
        if redis.call("GET", KEYS[1]) ~= ARGV[1] then
          return -1
        end
        if redis.call("EXISTS", KEYS[2]) == 1 then
          return 0
        end
        redis.call("SET", KEYS[2], "1", "EX", 31536000)
        redis.call("SET", KEYS[3], "unlocked")
        redis.call("DEL", KEYS[1])
        return 1
      `;

      const result = await redis([
        "EVAL", script, "3",
        "session:" + ymid,
        "reward:" + ymid,
        "patient:" + telegram_id + ":access",
        String(telegram_id)
      ]);

      if (result === -1) {
        return res.status(200).send("Unknown or mismatched ad session");
      }

      return res.status(200).send(
        result === 1 ? "Reward saved" : "Duplicate ignored"
      );
    }

    // Mini App requests
    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    const user = verifyTelegram(req.body?.initData);

    if (!user?.id) {
      return res.status(401).json({ error: "Invalid Telegram session" });
    }

    const telegramId = String(user.id);
    const action = req.body?.action;

    if (action === "start") {
      const ymid = crypto.randomUUID();

      await redis([
        "SET", "session:" + ymid, telegramId,
        "EX", 1800, "NX"
      ]);

      return res.status(200).json({
        success: true,
        ymid
      });
    }

    if (action === "status") {
      const access = await redis([
        "GET", "patient:" + telegramId + ":access"
      ]);

      return res.status(200).json({
        access: access === "unlocked"
      });
    }

    if (action === "end") {
      await redis([
        "DEL", "patient:" + telegramId + ":access"
      ]);

      return res.status(200).json({ access: false });
    }

    return res.status(400).json({ error: "Unknown action" });

  } catch (error) {
    console.error("Reward API:", error.message);
    return res.status(500).send("Server error");
  }
};
