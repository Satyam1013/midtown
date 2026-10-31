/** Last ten digits, so +91 / spaces on either side still match. */
export const normalizePhone = (phone?: string | null): string => (phone ?? '').replace(/\D/g, '').slice(-10);
