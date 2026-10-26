package expo.modules.screentime

import org.json.JSONObject

/** The v1 state format predates sources; those saved receipts are request grants. */
internal object ApprovalStorage {
  fun read(json: JSONObject, owner: String?): ActiveApproval {
    val receipt = Approval(
      json.getString("grantId"), json.getString("requesterId"),
      if (json.isNull("requestId")) null else json.getString("requestId"),
      json.getString("startedAt"), json.getString("expiresAt"), json.getString("serverNow"),
      if (json.has("source")) json.getString("source") else "request",
    )
    receipt.validateStructure(owner)
    return ActiveApproval(receipt, json.getLong("elapsedEnd"), json.getInt("boot"))
  }

  fun write(active: ActiveApproval): JSONObject {
    val receipt = active.receipt
    return JSONObject().put("grantId", receipt.grantId).put("requesterId", receipt.requesterId)
      .put("source", receipt.source).put("requestId", receipt.requestId ?: JSONObject.NULL)
      .put("startedAt", receipt.startedAt).put("expiresAt", receipt.expiresAt)
      .put("serverNow", receipt.serverNow).put("elapsedEnd", active.elapsedEnd).put("boot", active.boot)
  }
}
