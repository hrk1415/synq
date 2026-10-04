import { NextRequest } from 'next/server';
import { notifyDealConfirmedToSeller, notifyBuyerWorkSubmitted, notifyBuyerDealCompleted, notifySellerDealCompleted, notifyDealCancelled, notifySellerPaymentReleased, notifySellerOrderInquiry, notifyNewChatMessage, notifyBuyerOrderConfirmed, type NotifyPayload } from '@/lib/notify';
import { getAuthenticatedWallet, unauthorized } from '@/lib/auth';

/** Retained as an explicit tombstone; mail configuration is server-only. */
export async function GET() {
  return Response.json(
    { error: 'Notification configuration is not publicly available' },
    { status: 410 },
  );
}

export async function POST(req: NextRequest) {
  const authenticatedWallet = getAuthenticatedWallet(req);
  if (!authenticatedWallet) return unauthorized();

  try {
    const body = await req.json();
    const event = body.event as NotifyPayload['event'];

    const fn = {
      deal_confirmed: notifyDealConfirmedToSeller,
      work_submitted: notifyBuyerWorkSubmitted,
      deal_completed: notifyBuyerDealCompleted,
      deal_completed_seller: notifySellerDealCompleted,
      deal_cancelled: notifyDealCancelled,
      payment_released: notifySellerPaymentReleased,
      order_inquiry: notifySellerOrderInquiry,
      chat_message: notifyNewChatMessage,
      order_confirmed: notifyBuyerOrderConfirmed,
    }[event];

    if (!fn) {
      return Response.json({ error: 'Invalid event. Use deal_confirmed, work_submitted, deal_completed, deal_completed_seller, deal_cancelled, payment_released, order_inquiry, chat_message or order_confirmed.' }, { status: 400 });
    }

    const payload: NotifyPayload = {
      event,
      recipientName: body.recipientName,
      recipientWallet: body.recipientWallet,
      dealTitle: body.dealTitle,
      dealAmount: body.dealAmount,
      dealId: body.dealId,
      note: body.note,
      evidence: body.evidence,
      fromName: body.fromName,
      messagePreview: body.messagePreview,
      link: body.link,
    };

    const result = await fn(payload);
    return Response.json(result);
  } catch {
    return Response.json({ error: 'Notification delivery failed' }, { status: 500 });
  }
}
