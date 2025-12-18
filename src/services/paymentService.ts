// Paystack Payment Service
// API key will be added to .env when available

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';

interface PaymentData {
    email: string;
    amount: number; // In kobo (NGN) or smallest currency unit
    plan: string;
    telegramId: string;
    currency?: string;
}

// Initialize payment and get payment link
export async function initializePayment(data: PaymentData): Promise<{ success: boolean; url?: string; reference?: string; error?: string }> {
    if (!PAYSTACK_SECRET) {
        // Return placeholder if no API key yet
        return {
            success: true,
            url: `https://paystack.com/pay/caseview-${data.plan.toLowerCase()}`,
            reference: `placeholder_${Date.now()}`
        };
    }

    try {
        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: data.email,
                amount: data.amount * 100, // Convert to kobo
                currency: data.currency || 'NGN',
                callback_url: process.env.PAYSTACK_CALLBACK_URL || 'https://your-domain.com/payment/callback',
                metadata: {
                    plan: data.plan,
                    telegramId: data.telegramId
                }
            })
        });

        const result = await response.json() as { status: boolean; data?: { authorization_url: string; reference: string } };

        if (result.status && result.data) {
            return {
                success: true,
                url: result.data.authorization_url,
                reference: result.data.reference
            };
        } else {
            return { success: false, error: 'Payment initialization failed' };
        }
    } catch (error) {
        console.error('Paystack error:', error);
        return { success: false, error: 'Payment service unavailable' };
    }
}

// Verify payment (called by webhook or callback)
export async function verifyPayment(reference: string): Promise<{ success: boolean; data?: any; error?: string }> {
    if (!PAYSTACK_SECRET) {
        return { success: false, error: 'API key not configured' };
    }

    try {
        const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET}`
            }
        });

        const result = await response.json() as { status: boolean; data?: { status: string; metadata?: { plan: string; telegramId: string } } };

        if (result.status && result.data?.status === 'success') {
            return { success: true, data: result.data };
        } else {
            return { success: false, error: 'Payment not verified' };
        }
    } catch (error) {
        console.error('Verify payment error:', error);
        return { success: false, error: 'Verification failed' };
    }
}

// Get plan prices for Paystack
export function getPlanAmount(plan: string, currency: string = 'NGN'): number {
    const prices: Record<string, Record<string, number>> = {
        PRO: { USD: 8, NGN: 12400, GBP: 7, EUR: 8 },
        FIRM: { USD: 49, NGN: 76000, GBP: 40, EUR: 45 },
        BAR: { USD: 199, NGN: 309000, GBP: 160, EUR: 180 }
    };

    return prices[plan]?.[currency] || prices[plan]?.USD || 0;
}
