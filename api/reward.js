
module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const expectedSecret = process.env.POSTBACK_SECRET;
  const receivedSecret = req.query.secret;

  if (!expectedSecret) {
    console.error("POSTBACK_SECRET is missing");
    return res.status(500).send("Server configuration error");
  }

  if (!receivedSecret || receivedSecret !== expectedSecret) {
    return res.status(403).send("Invalid secret");
  }

  const {
    ymid,
    event_type,
    reward_event_type,
    zone_id,
    sub_zone_id,
    telegram_id,
    estimated_price,
    request_var
  } = req.query;

  if (
    !ymid ||
    !["impression", "click"].includes(event_type) ||
    !["valued", "non_valued"].includes(reward_event_type)
  ) {
    return res.status(400).send("Invalid postback data");
  }

  console.log("MONETAG POSTBACK:", {
    ymid,
    event_type,
    reward_event_type,
    zone_id,
    sub_zone_id,
    telegram_id,
    estimated_price,
    request_var
  });

  return res.status(200).send("Postback received");
};
