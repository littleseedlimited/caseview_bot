
export interface SmartLink {
    name: string;
    url: string;
    description: string;
}

export function generateSmartLinks(query: string): SmartLink[] {
    const q = encodeURIComponent(query);
    return [
        {
            name: '🇳🇬 Nigeria Court of Appeal',
            url: `https://www.google.com/search?q=site:courtofappeal.gov.ng+${q}`,
            description: 'Search official judgments via Google'
        },
        {
            name: '🇳🇬 NigeriaLII',
            url: `https://nigerialii.org/search/node/${q}`,
            description: 'Nigeria Legal Information Institute'
        },
        {
            name: '🇺🇸 Cornell LII',
            url: `https://www.law.cornell.edu/search/lii?query=${q}`,
            description: 'US Code & Supreme Court'
        },
        {
            name: '🇺🇸 Harvard Caselaw',
            url: `https://cite.case.law/search/?q=${q}`,
            description: 'Harvard Caselaw Access Project'
        },
        {
            name: '🌍 Google Scholar',
            url: `https://scholar.google.com/scholar?q=${q}&hl=en&as_sdt=2006`,
            description: 'Global Legal Search'
        }
    ];
}
