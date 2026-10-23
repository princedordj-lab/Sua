import { Router } from "express";
import { Webhook } from "svix";
import { deleteAccountData } from "../lib/account.js";

export const clerkWebhookRouter = Router();

clerkWebhookRouter.post("/", async (req, res) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    console.error("CLERK_WEBHOOK_SECRET is not set");
    return res.status(500).json({ error: "Webhook not configured" });
  }

  const svixId = req.headers["svix-id"];
  const svixTimestamp = req.headers["svix-timestamp"];
  const svixSignature = req.headers["svix-signature"];
  if (!svixId || !svixTimestamp || !svixSignature) {
    return res.status(400).json({ error: "Missing svix headers" });
  }

  let event;
  try {
    const wh = new Webhook(secret);
    event = wh.verify(req.body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
  } catch (err) {
    console.error("Webhook signature verification failed", err);
    return res.status(400).json({ error: "Invalid signature" });
  }

  const { type, data } = event;

  try {
    switch (type) {
      case "user.created":
      case "user.updated": {
        const email =
          data.email_addresses?.find(
            (e) => e.id === data.primary_email_address_id,
          )?.email_address ??
          data.email_addresses?.[0]?.email_address ??
          null;
        const name =
          [data.first_name, data.last_name].filter(Boolean).join(" ") || null;
        if (!email) break;
        await withUser(data.id, (tx) =>
          tx.user.upsert({
            where: { clerkId: data.id },
            update: { email, name },
            create: { clerkId: data.id, email, name },
          }),
        );
        break;
      }
      case "user.deleted": {
        // Same path POST /me/delete uses: files first, then the cascading
        // user delete. Idempotent if the client already ran it.
        if (data.id) {
          try {
            await deleteAccountData(data.id);
          } catch (err) {
            console.error("Account cleanup failed on user.deleted", err);
          }
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error(`Webhook ${type} failed`, err);
    return res.status(500).json({ error: "Webhook handler failed" });
  }

  res.status(204).end();
});
