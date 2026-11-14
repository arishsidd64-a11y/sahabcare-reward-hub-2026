
const crypto = require("crypto");

const ZONE_ID = "12244637";

function verifyTelegram(initData) {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!hash || !authDate ||
      Math.abs(Date.now() / 1000 - authDate) > 86400) {
    return null;
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (!crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(calculatedHash, "hex")
  )) return null;

  try {
    return JSON.parse(params.get("user") || "{}");
  } catch {
    return null;
  }
}

async function redisCommand(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) throw new Error("Redis configuration missing");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error("Redis request failed");
  }

  return data.result;
}

module.exports = async (req, res) => {
  try {
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

      if (!ymid || !/^[a-zA-Z0-9_.-]{1,120}$/.test(ymid) ||
          !telegram_id || !/^\d+$/.test(String(telegram_id)) ||
          zone_id !== ZONE_ID ||
          !["impression", "click"].includes(event_type)) {
        return res.status(400).send("Invalid postback data");
      }

      if (reward_event_type !== "valued") {
        return res.status(200).send("No reward");
      }

      const script = `
        if redis.call("EXISTS", KEYS[1]) == 1 then
          return 0
        end
        redis.call("SET", KEYS[1], ARGV[1])
        redis.call("SET", KEYS[2], "unlocked")
        return 1
      `;

      const result = await redisCommand([
        "EVAL", script, "2",
        "reward:" + ymid,
        "patient:" + telegram_id + ":access",
        String(telegram_id)
      ]);

      return res.status(200).send(
        result === 1 ? "Reward saved" : "Duplicate ignored"
      );
    }

    // Authenticated Mini App access-status check
    if (req.method === "POST") {
      const initData = req.body && req.body.initData;
      const user = verifyTelegram(initData);

      if (!user || !user.id) {
        return res.status(401).json({ error: "Invalid Telegram session" });
      }

      const status = await redisCommand([
        "GET", "patient:" + user.id + ":access"
      ]);

      return res.status(200).json({
        telegramId: user.id,
        access: status === "unlocked"
      });
    }

    return res.status(405).send("Method not allowed");

  } catch (error) {
    console.error("Reward API error:", error.message);
    return res.status(500).send("Server error");
  }
};
