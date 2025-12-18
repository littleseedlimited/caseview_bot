// Real Legal Research Service
import axios from 'axios';
import { SmartLink, generateSmartLinks } from './smartLinks';

const COURTLISTENER_API_KEY = process.env.COURTLISTENER_API_KEY;

export interface LegalCase {
    id: string;
    name: string;
    citation: string;
    year: number;
    url: string;
    snippet: string;
    source: 'CourtListener' | 'HarvardCAP' | 'GoogleScholar';
    court?: string;
}

export async function searchAllDatabases(query: string, includePaid: boolean = false, filters?: { jurisdiction?: string, db?: string }): Promise<LegalCase[]> {
    console.log(`[Research] Searching for: "${query}" in ${filters?.jurisdiction || 'Global'}...`);

    const region = filters?.jurisdiction?.toUpperCase() || 'US';
    let results: LegalCase[] = [];

    if (region === 'US') {
        results = await searchCourtListener(query);
    } else {
        results = searchGlobal(query, region);
    }

    const smartLinks = generateSmartLinks(query);
    const smartResults: LegalCase[] = smartLinks.filter(sl => {
        if (region === 'NIGERIA' && !sl.name.includes('Nigeria')) return false;
        return true;
    }).map(link => ({
        id: `smart-${Math.random()}`,
        name: `${link.name} Search`,
        citation: 'External DB',
        year: new Date().getFullYear(),
        url: link.url,
        snippet: `Direct search link for "${query}" in ${link.name}.`,
        source: 'GoogleScholar' as const,
    }));

    return [...results, ...smartResults];
}

export async function searchPrecedents(query: string): Promise<LegalCase[]> {
    return searchCourtListener(query);
}

// Helper to get formatted Smart Links for the bot
export function getExtendedResearchLinks(query: string): string {
    const links = generateSmartLinks(query);
    let msg = `\n🌐 **Global & Specialized Databases**\n`;
    links.forEach(l => {
        msg += `- [${l.name}](${l.url}) - _${l.description}_\n`;
    });
    return msg;
}

// Helper: Global/Regional Deep Links
function searchGlobal(query: string, region: string): LegalCase[] {
    const q = encodeURIComponent(query);
    const results: LegalCase[] = [];
    const year = new Date().getFullYear();

    if (region === 'NIGERIA') {
        results.push({
            id: 'ng-1', name: 'NigeriaLII Search', citation: 'NigeriaLII', year,
            url: `https://nigerialii.org/search/all/${q}`,
            snippet: `Search results for "${query}" on Nigeria Legal Information Institute.`,
            source: 'CourtListener'
        });
        results.push({
            id: 'ng-2', name: 'LawNigeria Research', citation: 'LawNigeria', year,
            url: `https://lawnigeria.com/?s=${q}`,
            snippet: `Search results for "${query}" on LawNigeria.com.`,
            source: 'CourtListener'
        });
    }
    else if (region === 'AFRICA') {
        results.push({
            id: 'afr-1', name: 'AfricanLII Search', citation: 'AfricanLII', year,
            url: `https://africanlii.org/search/all/${q}`,
            snippet: `Pan-African legal search for "${query}".`,
            source: 'CourtListener'
        });
        results.push({
            id: 'afr-2', name: 'SafLII (Southern Africa)', citation: 'SafLII', year,
            url: `http://www.saflii.org/cgi-bin/sinosearch.pl?query=${q}`,
            snippet: `Southern African Legal Information Institute search.`,
            source: 'CourtListener'
        });
    }
    else if (region === 'EUROPE') {
        results.push({
            id: 'eu-1', name: 'EUR-Lex (EU Law)', citation: 'EUR-Lex', year,
            url: `https://eur-lex.europa.eu/search.html?text=${q}&scope=EURLEX&type=quick`,
            snippet: `European Union Law search for "${query}".`,
            source: 'CourtListener'
        });
        results.push({
            id: 'eu-2', name: 'BAILII (UK/Ireland)', citation: 'BAILII', year,
            url: `https://www.bailii.org/cgi-bin/sino_search_1.cgi?query=${q}`,
            snippet: `British and Irish Legal Information Institute search.`,
            source: 'CourtListener'
        });
        results.push({
            id: 'eu-3', name: 'HUDOC (Human Rights)', citation: 'ECHR', year,
            url: `https://hudoc.echr.coe.int/eng#{%22fulltext%22:[%22${query}%22]}`,
            snippet: `European Court of Human Rights Case Law.`,
            source: 'CourtListener'
        });
    }
    else { // GLOBAL
        results.push({
            id: 'glb-1', name: 'WorldLII Global Search', citation: 'WorldLII', year,
            url: `http://www.worldlii.org/form/search/?q=${q}`,
            snippet: `Global legal search across all jurisdictions for "${query}".`,
            source: 'CourtListener'
        });
        results.push({
            id: 'glb-2', name: 'Google Scholar Case Law', citation: 'Google', year,
            url: `https://scholar.google.com/scholar?q=${q}&hl=en&as_sdt=0,33`,
            snippet: `Google Scholar search for "${query}".`,
            source: 'GoogleScholar'
        });
    }

    return results;
}

// Helper: Real CourtListener Call
async function searchCourtListener(query: string): Promise<LegalCase[]> {
    if (!COURTLISTENER_API_KEY) {
        console.warn('[CourtListener] No API key found, using fallback search');
        return getFallbackResults(query);
    }

    try {
        console.log('[CourtListener] Searching with API key...');

        const response = await axios.get('https://www.courtlistener.com/api/rest/v3/search/', {
            params: {
                q: query,
                type: 'o',
            },
            headers: {
                'Authorization': `Token ${COURTLISTENER_API_KEY}`
            },
            timeout: 10000 // 10 second timeout
        });

        if (response.data && response.data.results && response.data.results.length > 0) {
            console.log(`[CourtListener] Found ${response.data.results.length} results`);
            return response.data.results.slice(0, 5).map((r: any) => ({
                id: r.id ? String(r.id) : `cl-${Math.random()}`,
                name: r.caseName || r.case_name || "Unknown Case",
                citation: r.citation ? r.citation.slice(0, 50) : "No Citation",
                year: r.dateFiled ? new Date(r.dateFiled).getFullYear() : new Date().getFullYear(),
                url: `https://www.courtlistener.com${r.absolute_url}`,
                snippet: r.snippet || "Click to view full case opinion on CourtListener.",
                source: 'CourtListener' as const,
                court: r.court || "US Court"
            }));
        }

        console.log('[CourtListener] No results found, using fallback');
        return getFallbackResults(query);

    } catch (e: any) {
        console.error("[CourtListener] API Error:", e.message || e);
        return getFallbackResults(query);
    }
}

// Fallback when CourtListener fails
function getFallbackResults(query: string): LegalCase[] {
    const q = encodeURIComponent(query);
    return [
        {
            id: 'gscholar-1',
            name: `Google Scholar: "${query}"`,
            citation: 'External Search',
            year: new Date().getFullYear(),
            url: `https://scholar.google.com/scholar?q=${q}&hl=en&as_sdt=0,33`,
            snippet: "Search Google Scholar for case law and legal documents.",
            source: 'GoogleScholar'
        },
        {
            id: 'courtlistener-web',
            name: `CourtListener Web Search`,
            citation: 'Direct Search',
            year: new Date().getFullYear(),
            url: `https://www.courtlistener.com/?q=${q}&type=o`,
            snippet: "Search CourtListener directly via web interface.",
            source: 'CourtListener'
        }
    ];
}