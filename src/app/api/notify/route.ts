import { NextRequest } from 'next/server';
import { notifyDealConfirmedToSeller, notifyBuyerWorkSubmitted, notifyBuyerDealCompleted, notifySellerDealCompleted, notifyDealCancelled, notifySellerPaymentReleased, notifySellerOrderInquiry, notifyNewChatMessage, notifyBuyerOrderConfirmed, getMailStatus, type NotifyPayload } from '@/lib/notify';

/**
 * Delivery-config status. Lets the UI (and the operator) see whether email
 * actually leaves the machine, instead of discovering months later that every
 * notification went to data/emails.log. Returns no secret values — the login is
 * masked and the password is never read here.
 */
export async function GET() {
  return Response.json(getMailStatus());
}

export async function POST(req: NextRequest) {
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
      recipientEmail: body.recipientEmail,
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
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}