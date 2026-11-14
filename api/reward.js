
module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const {
    secret,
    ymid,
    event_type,
    reward_event_type,
    telegram_id
  } = req.query;

  if (!process.env.POSTBACK_SECRET ||
      secret !== process.env.POSTBACK_SECRET) {
    return res.status(403).send("Invalid secret");
  }

  if (!ymid || !telegram_id ||
      !/^\d+$/.test(String(telegram_id))) {
    return res.status(400).send("Invalid postback data");
  }

  if (!["impression", "click"].includes(event_type)) {
    return res.status(400).send("Invalid event");
  }

  if (reward_event_type !== "valued") {
    return res.status(200).send("No reward");
  }

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    return res.status(500).send("Redis configuration missing");
  }

  const script = `
    if redis.call("EXISTS", KEYS[1]) == 1 then
      return 0
    end
    redis.call("SET", KEYS[1], ARGV[1])
    redis.call("SET", KEYS[2], "unlocked")
    return 1
  `;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify([
        "EVAL",
        script,
        "2",
        "reward:" + ymid,
        "patient:" + telegram_id + ":access",
        String(telegram_id)
      ])
    });

    const result = await response.json();

    if (!response.ok || result.error) {
      console.error("Redis error:", result);
      return res.status(500).send("Database error");
    }

    return res.status(200).send(
      result.result === 1
        ? "Reward saved"
        : "Duplicate ignored"
    );

  } catch (error) {
    console.error(error);
    return res.status(500).send("Server error");
  }
};
