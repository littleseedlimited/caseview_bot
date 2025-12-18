// Currency service with exchange rates and country list

export const COUNTRIES = [
    { code: 'NG', name: 'Nigeria', currency: 'NGN', symbol: '₦' },
    { code: 'US', name: 'United States', currency: 'USD', symbol: '$' },
    { code: 'GB', name: 'United Kingdom', currency: 'GBP', symbol: '£' },
    { code: 'GH', name: 'Ghana', currency: 'GHS', symbol: '₵' },
    { code: 'KE', name: 'Kenya', currency: 'KES', symbol: 'KSh' },
    { code: 'ZA', name: 'South Africa', currency: 'ZAR', symbol: 'R' },
    { code: 'CA', name: 'Canada', currency: 'CAD', symbol: 'C$' },
    { code: 'AU', name: 'Australia', currency: 'AUD', symbol: 'A$' },
    { code: 'IN', name: 'India', currency: 'INR', symbol: '₹' },
    { code: 'AE', name: 'UAE', currency: 'AED', symbol: 'د.إ' },
    { code: 'DE', name: 'Germany', currency: 'EUR', symbol: '€' },
    { code: 'FR', name: 'France', currency: 'EUR', symbol: '€' },
    { code: 'IT', name: 'Italy', currency: 'EUR', symbol: '€' },
    { code: 'ES', name: 'Spain', currency: 'EUR', symbol: '€' },
    { code: 'NL', name: 'Netherlands', currency: 'EUR', symbol: '€' },
    { code: 'BE', name: 'Belgium', currency: 'EUR', symbol: '€' },
    { code: 'CH', name: 'Switzerland', currency: 'CHF', symbol: 'CHF' },
    { code: 'JP', name: 'Japan', currency: 'JPY', symbol: '¥' },
    { code: 'CN', name: 'China', currency: 'CNY', symbol: '¥' },
    { code: 'SG', name: 'Singapore', currency: 'SGD', symbol: 'S$' },
    { code: 'HK', name: 'Hong Kong', currency: 'HKD', symbol: 'HK$' },
    { code: 'MY', name: 'Malaysia', currency: 'MYR', symbol: 'RM' },
    { code: 'PH', name: 'Philippines', currency: 'PHP', symbol: '₱' },
    { code: 'TH', name: 'Thailand', currency: 'THB', symbol: '฿' },
    { code: 'ID', name: 'Indonesia', currency: 'IDR', symbol: 'Rp' },
    { code: 'VN', name: 'Vietnam', currency: 'VND', symbol: '₫' },
    { code: 'PK', name: 'Pakistan', currency: 'PKR', symbol: '₨' },
    { code: 'BD', name: 'Bangladesh', currency: 'BDT', symbol: '৳' },
    { code: 'EG', name: 'Egypt', currency: 'EGP', symbol: 'E£' },
    { code: 'TR', name: 'Turkey', currency: 'TRY', symbol: '₺' },
    { code: 'SA', name: 'Saudi Arabia', currency: 'SAR', symbol: 'ر.س' },
    { code: 'BR', name: 'Brazil', currency: 'BRL', symbol: 'R$' },
    { code: 'MX', name: 'Mexico', currency: 'MXN', symbol: '$' },
    { code: 'AR', name: 'Argentina', currency: 'ARS', symbol: '$' },
    { code: 'CO', name: 'Colombia', currency: 'COP', symbol: '$' },
    { code: 'CL', name: 'Chile', currency: 'CLP', symbol: '$' },
    { code: 'RU', name: 'Russia', currency: 'RUB', symbol: '₽' },
    { code: 'PL', name: 'Poland', currency: 'PLN', symbol: 'zł' },
    { code: 'SE', name: 'Sweden', currency: 'SEK', symbol: 'kr' },
    { code: 'NO', name: 'Norway', currency: 'NOK', symbol: 'kr' },
    { code: 'DK', name: 'Denmark', currency: 'DKK', symbol: 'kr' },
    { code: 'NZ', name: 'New Zealand', currency: 'NZD', symbol: 'NZ$' },
    { code: 'IE', name: 'Ireland', currency: 'EUR', symbol: '€' },
    { code: 'TZ', name: 'Tanzania', currency: 'TZS', symbol: 'TSh' },
    { code: 'UG', name: 'Uganda', currency: 'UGX', symbol: 'USh' },
    { code: 'RW', name: 'Rwanda', currency: 'RWF', symbol: 'FRw' },
    { code: 'CM', name: 'Cameroon', currency: 'XAF', symbol: 'FCFA' },
    { code: 'CI', name: 'Ivory Coast', currency: 'XOF', symbol: 'CFA' },
    { code: 'SN', name: 'Senegal', currency: 'XOF', symbol: 'CFA' },
];

// Cache for exchange rates (refresh every hour)
let ratesCache: { rates: Record<string, number>; timestamp: number } | null = null;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

// Fetch live exchange rates from free API
export async function getExchangeRates(): Promise<Record<string, number>> {
    // Check cache first
    if (ratesCache && Date.now() - ratesCache.timestamp < CACHE_DURATION) {
        return ratesCache.rates;
    }

    try {
        // Using free exchangerate-api.com or similar
        const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
        const data = await response.json() as { rates: Record<string, number> };

        ratesCache = {
            rates: data.rates,
            timestamp: Date.now()
        };

        return data.rates;
    } catch (error) {
        console.error('Failed to fetch exchange rates:', error);
        // Fallback rates if API fails
        return {
            USD: 1, NGN: 1550, GBP: 0.79, EUR: 0.92, GHS: 12.5, KES: 154,
            ZAR: 18.5, CAD: 1.36, AUD: 1.53, INR: 83.5, AED: 3.67, CHF: 0.88
        };
    }
}

// Convert USD amount to local currency
export async function convertToLocal(usdAmount: number, currencyCode: string): Promise<{ amount: number; formatted: string }> {
    const rates = await getExchangeRates();
    const rate = rates[currencyCode] || 1;
    const amount = Math.round(usdAmount * rate * 100) / 100;

    const country = COUNTRIES.find(c => c.currency === currencyCode);
    const symbol = country?.symbol || currencyCode;

    return {
        amount,
        formatted: `${symbol}${amount.toLocaleString()}`
    };
}

// Get plan prices in USD and local currency
export async function getPlanPrices(currencyCode: string) {
    const plans = [
        { name: 'FREE', usd: 0 },
        { name: 'PRO', usd: 8 },
        { name: 'FIRM', usd: 49 },
        { name: 'BAR', usd: 199 }
    ];

    const prices = await Promise.all(plans.map(async (plan) => {
        const local = await convertToLocal(plan.usd, currencyCode);
        return {
            name: plan.name,
            usd: plan.usd,
            local: local.amount,
            localFormatted: local.formatted
        };
    }));

    return prices;
}

export function getCountryByCode(code: string) {
    return COUNTRIES.find(c => c.code === code);
}

export function getCountryByCurrency(currency: string) {
    return COUNTRIES.find(c => c.currency === currency);
}
