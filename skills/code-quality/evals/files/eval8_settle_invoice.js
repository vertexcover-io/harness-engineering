// Implement `settleInvoice` per the rules below. Nothing here is implemented yet.
//
// Rules:
//  1. Reject if the invoice status is not 'OPEN'.
//  2. Reject if the payment amount is <= 0.
//  3. A payment covering >= the balance settles the invoice: status 'PAID', balance 0.
//  4. Otherwise it is partial: balance reduced, status stays 'OPEN'.
//  5. Late fee: if now is past dueDate, add 1.5% of the balance (rounded to cents)
//     to the balance BEFORE applying the payment. Fee applies once — skip it if
//     invoice.lateFeeApplied is already true.
//  6. Return the updated invoice plus the amount actually applied.

export const LATE_FEE_BPS = 150;

export const settleInvoice = ({ invoice, paymentCents, now }) => {
  throw new Error('not implemented');
};
