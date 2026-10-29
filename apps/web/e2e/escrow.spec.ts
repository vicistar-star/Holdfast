import { test, expect } from "@playwright/test";

test.describe("Holdfast Escrow Web E2E Suite", () => {
  // In-memory state shared across the test context
  let linkState = {
    id: "lnk_101",
    slug: "vintage-boots",
    title: "Vintage Leather Boots",
    amount_minor: "4500000", // 45,000 NGN
    currency: "NGN",
    ship_by_hours: 48,
    review_hours: 24,
    seller: {
      handle: "chioma_lux",
      kyc_tier: 2,
    },
  };

  let orderState = {
    id: "ord_202",
    status: "Funded",
    amount_minor: "4500000",
    currency: "NGN",
    ship_by: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    shipped_at: null as string | null,
    review_ends: null as string | null,
    created_at: new Date().toISOString(),
  };

  let disputeState = {
    id: "disp_303",
    order_id: "ord_202",
    reason: "damaged",
    opened_at: new Date().toISOString(),
    resolved_at: null as string | null,
    buyer_share_minor: null as string | null,
    seller_share_minor: null as string | null,
    rationale: null as string | null,
  };

  test.beforeEach(async ({ page }) => {
    // Intercept backend API calls with mock responses
    await page.route("**/v1/**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();

      // Seller Auth: Request OTP
      if (url.pathname.endsWith("/auth/otp/request") && method === "POST") {
        return route.fulfill({ status: 200, json: { success: true } });
      }

      // Seller Auth: Verify OTP
      if (url.pathname.endsWith("/auth/otp/verify") && method === "POST") {
        return route.fulfill({
          status: 200,
          json: {
            token: "mock-seller-token",
            user: { role: "seller" },
            seller: {
              id: "sel_1",
              handle: "chioma_lux",
              kyc_tier: 2,
              payout_ref: "bank_acc_123",
            },
          },
        });
      }

      // Seller Dashboard: Orders
      if (url.pathname.endsWith("/orders") && method === "GET") {
        return route.fulfill({
          status: 200,
          json: {
            orders: [
              {
                id: orderState.id,
                buyer_phone: "08012345678",
                amount_minor: orderState.amount_minor,
                currency: orderState.currency,
                status: orderState.status,
                ship_by: orderState.ship_by,
                shipped_at: orderState.shipped_at,
                review_ends: orderState.review_ends,
                created_at: orderState.created_at,
              },
            ],
          },
        });
      }

      // Seller Profile
      if (url.pathname.endsWith("/sellers/me") && method === "GET") {
        return route.fulfill({
          status: 200,
          json: {
            id: "sel_1",
            handle: "chioma_lux",
            kyc_tier: 2,
            payout_ref: "bank_acc_123",
          },
        });
      }

      // Seller Reputation
      if (url.pathname.includes("/reputation") && method === "GET") {
        return route.fulfill({
          status: 200,
          json: {
            handle: "chioma_lux",
            kyc_tier: 2,
            is_verified: true,
            has_minimum_sample: true,
            isNewSeller: false,
            completedOrdersLifetime: 24,
            completedOrdersTrailing90d: 18,
            volumeBand: "100k_1m",
            disputeRate: 0,
            disputesLost: 0,
            medianShipHours: 14,
            medianResponseHours: 1,
            accountAgeDays: 120,
            antiGamingFlag: false,
          },
        });
      }

      // Link Creation
      if (url.pathname.endsWith("/links") && method === "POST") {
        const body = route.request().postDataJSON();
        linkState = {
          ...linkState,
          title: body.title,
          amount_minor: String(BigInt(body.amount_minor || "4500000")),
        };
        return route.fulfill({
          status: 201,
          json: {
            id: "lnk_new_99",
            slug: "vintage-boots",
            title: linkState.title,
            amount_minor: linkState.amount_minor,
            currency: "NGN",
          },
        });
      }

      // Buyer Pay Page: Get Link
      if (url.pathname.includes("/links/vintage-boots") && method === "GET") {
        return route.fulfill({
          status: 200,
          json: linkState,
        });
      }

      // Buyer Pay: Create & Fund Order
      if (url.pathname.includes("/links/vintage-boots/orders") && method === "POST") {
        orderState.status = "Funded";
        return route.fulfill({
          status: 200,
          json: {
            id: orderState.id,
            status: "Funded",
            ship_by: orderState.ship_by,
            order_token: "order_secret_token_buyer",
            payment_instructions: {
              account_number: "9988776655",
              bank_name: "Safe Escrow Partner Bank",
              reference: "REF-BOOTS-001",
              instructions: "Transfer exactly ₦45,000 to complete your escrow order.",
            },
          },
        });
      }

      // Order by ID
      if (url.pathname.includes(`/orders/${orderState.id}`) && method === "GET") {
        return route.fulfill({
          status: 200,
          json: orderState,
        });
      }

      // Mark Shipped
      if (url.pathname.includes(`/orders/${orderState.id}/ship`) && method === "POST") {
        orderState.status = "Shipped";
        orderState.shipped_at = new Date().toISOString();
        orderState.review_ends = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        return route.fulfill({
          status: 200,
          json: { success: true, order: orderState },
        });
      }

      // Confirm Delivery
      if (url.pathname.includes(`/orders/${orderState.id}/confirm`) && method === "POST") {
        orderState.status = "Released";
        return route.fulfill({
          status: 200,
          json: { success: true, status: "Released", order: orderState },
        });
      }

      // Open Dispute
      if (url.pathname.includes(`/orders/${orderState.id}/dispute`) && method === "POST") {
        orderState.status = "Disputed";
        return route.fulfill({
          status: 200,
          json: { success: true, dispute_id: disputeState.id, order: orderState },
        });
      }

      // Upload Evidence
      if (url.pathname.includes("/evidence/upload") && method === "POST") {
        return route.fulfill({
          status: 200,
          json: {
            id: "evi_909",
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
        });
      }

      // Arbiter Dispute Dossier
      if (url.pathname.includes(`/admin/disputes/${disputeState.id}`) && method === "GET") {
        return route.fulfill({
          status: 200,
          json: {
            dispute: disputeState,
            order: {
              ...orderState,
              buyer_phone: "08012345678",
              seller_handle: "chioma_lux",
            },
            timeline: [
              {
                id: 1,
                from_status: null,
                to_status: "Funded",
                actor: "buyer",
                note: "Paid via partner rails",
                tx_hash: null,
                created_at: orderState.created_at,
              },
              {
                id: 2,
                from_status: "Funded",
                to_status: "Shipped",
                actor: "seller",
                note: "Waybill: DHL-123456",
                tx_hash: null,
                created_at: new Date().toISOString(),
              },
              {
                id: 3,
                from_status: "Shipped",
                to_status: "Disputed",
                actor: "buyer",
                note: "Damaged item reported",
                tx_hash: null,
                created_at: new Date().toISOString(),
              },
            ],
            evidence: [
              {
                id: "evi_909",
                uploaded_by: "buyer",
                object_key: "evidence/ord_202/damage_proof.jpg",
                sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                hash_verified: true,
                created_at: new Date().toISOString(),
              },
            ],
            statements: {
              buyer_dispute_reason: "damaged",
              buyer_dispute_note: "Left boot heel was cracked upon opening packaging.",
              seller_shipping_waybill: "DHL-123456",
              seller_shipping_note: "Dispatched via DHL express.",
            },
            requires_second_approver: false,
          },
        });
      }

      // Arbiter Resolve
      if (url.pathname.includes(`/admin/disputes/${disputeState.id}/resolve`) && method === "POST") {
        const body = route.request().postDataJSON();
        disputeState.resolved_at = new Date().toISOString();
        disputeState.buyer_share_minor = body.buyer_share_minor;
        disputeState.seller_share_minor = body.seller_share_minor;
        disputeState.rationale = body.rationale;
        orderState.status = "Resolved";

        return route.fulfill({
          status: 200,
          json: {
            success: true,
            dispute_id: disputeState.id,
            status: "Resolved",
            buyer_share_minor: body.buyer_share_minor,
            seller_share_minor: body.seller_share_minor,
          },
        });
      }

      return route.continue();
    });
  });

  test("Flow 1 - Happy Path: Create link -> Pay via /pay/[slug] -> Mark shipped -> Confirm delivery -> Released", async ({
    page,
  }) => {
    // 1. Seller logs into dashboard
    await page.goto("/dashboard");
    await page.getByPlaceholder("080 1234 5678").fill("08012345678");
    await page.getByRole("button", { name: "Send Verification Code" }).click();

    // Enter OTP
    await page.getByPlaceholder("123456").fill("123456");
    await page.getByRole("button", { name: "Sign In" }).click();

    // Verify dashboard rendered
    await expect(page.getByText("@chioma_lux")).toBeVisible();
    await expect(page.getByText("✓ Verified")).toBeVisible();

    // 2. Create Payment Link
    await page.getByPlaceholder("Vintage Denim Jacket (Size M)").fill("Vintage Leather Boots");
    await page.locator("#itemPrice").fill("45000");
    await page.getByRole("button", { name: "+ Create Escrow Link" }).click();

    // Link created banner
    await expect(page.getByText("Your Link is Ready to Share!")).toBeVisible();

    // 3. Buyer opens /pay/vintage-boots
    await page.goto("/pay/vintage-boots");
    await expect(page.getByRole("heading", { name: "Vintage Leather Boots" })).toBeVisible();
    await expect(page.getByText("₦45,000", { exact: true })).toBeVisible();
    await expect(page.getByText("How Your Escrow Works")).toBeVisible();

    // Buyer enters phone and clicks Pay
    await page.getByPlaceholder("080 1234 5678").fill("08099999999");
    await page.getByRole("button", { name: /Pay .* with Escrow/ }).click();

    // Payment Instructions appear
    await expect(page.getByText("Safe Escrow Partner Bank")).toBeVisible();
    await expect(page.getByText("9988776655")).toBeVisible();

    // Order status is Funded (Payment Held in Safe Escrow)
    await expect(page.getByText("Payment Received")).toBeVisible();
    await expect(page.getByText("Payment Held in Safe Escrow")).toBeVisible();

    // 4. Seller marks order shipped
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Mark as Shipped 📦" }).click();
    await page.getByPlaceholder("e.g. GIGM-1029384").fill("DHL-123456");
    await page.getByPlaceholder("Dispatched via courier today...").fill("Dispatched via DHL express");
    await page.getByRole("button", { name: "Confirm Shipment" }).click();

    // 5. Buyer confirms delivery
    await page.goto(`/pay/vintage-boots?order_id=${orderState.id}&token=order_secret_token_buyer`);
    await expect(page.getByText("Package On The Way")).toBeVisible();

    const confirmDeliveryBtn = page.getByRole("button", { name: "✓ Confirm Delivery & Release Payment" });
    await expect(confirmDeliveryBtn).toBeVisible();
    await confirmDeliveryBtn.click();

    // Order transitions to Released
    await expect(page.getByText("Order Completed")).toBeVisible();
    await expect(page.getByText("Delivery Confirmed & Settled")).toBeVisible();
  });

  test("Flow 2 - Refund Path: Ship deadline expires -> Keeper refund settlement -> Status Refunded", async ({
    page,
  }) => {
    // Simulate expired deadline and keeper refund settlement
    orderState.status = "Refunded";

    await page.goto(`/pay/vintage-boots?order_id=${orderState.id}&token=order_secret_token_buyer`);

    // Verify buyer sees Refunded status with clear explanation
    await expect(page.getByText("Refunded in Full")).toBeVisible();
    await expect(page.getByText("Payment Returned to Buyer")).toBeVisible();
  });

  test("Flow 3 - Dispute Path: Buyer reports problem with evidence -> Arbiter reviews case dossier -> Resolves split with rationale", async ({
    page,
  }) => {
    // Reset order to shipped
    orderState.status = "Shipped";
    orderState.shipped_at = new Date().toISOString();

    // 1. Buyer visits order page and reports problem
    await page.goto(`/pay/vintage-boots?order_id=${orderState.id}&token=order_secret_token_buyer`);
    await expect(page.getByText("Package On The Way")).toBeVisible();

    await page.getByRole("button", { name: "Report a Problem with this Order" }).click();

    // Dispute modal is visible
    await expect(page.getByRole("heading", { name: "Report an Issue" })).toBeVisible();
    await page.locator("select").selectOption("damaged");
    await page
      .getByPlaceholder("Describe what went wrong in detail...")
      .fill("Left boot heel was cracked upon opening packaging.");

    await page.getByRole("button", { name: "Submit Report" }).click();

    // Order changes to Disputed
    await expect(page.getByText("Under Review")).toBeVisible();
    await expect(page.getByText("Issue Reported — Under Arbiter Review")).toBeVisible();

    // 2. Arbiter navigates to Admin Dispute Dossier
    await page.goto(`/admin/disputes/${disputeState.id}?token=arbiter_secret_token`);

    // Check case details
    await expect(page.getByText("Case Dossier #disp_303")).toBeVisible();
    await expect(page.getByText("Left boot heel was cracked upon opening packaging.")).toBeVisible();
    await expect(page.getByText("✓ Hash Verified")).toBeVisible();

    // 3. Arbiter enters settlement split (pre-filled full refund to buyer)
    await page.locator('input[type="number"]').first().fill("45000"); // Buyer share
    await page.locator('input[type="number"]').last().fill("0"); // Seller share

    // Arbiter writes mandatory rationale
    await page
      .getByPlaceholder("Explain the settlement decision based on courier waybill and photos...")
      .fill("Courier packaging and inspection confirm defect upon delivery. Full refund granted to buyer.");

    // Submit review
    await page.getByRole("button", { name: "Review & Execute Settlement →" }).click();

    // Confirm modal
    await expect(page.getByRole("heading", { name: "Confirm Final Settlement" })).toBeVisible();
    await page.getByRole("button", { name: "Confirm & Settle" }).click();

    // Verified resolution banner
    await expect(
      page.getByText("Dispute successfully settled! Payouts and notifications instructed.")
    ).toBeVisible();
  });
});
