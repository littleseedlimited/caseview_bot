// Mock Viability and Scenario Analysis

export interface Scenario {
    name: string;
    probability: number;
    description: string;
    recommendedAction: string;
}

export interface CaseAnalysis {
    viabilityScore: number; // 0-100
    prediction: string;
    scenarios: Scenario[];
    keyIssues: string[];
    caseCategory: string; // New field
}

export async function analyzeCaseViability(facts: string): Promise<CaseAnalysis> {
    // Simulate AI processing time
    await new Promise(resolve => setTimeout(resolve, 2000));

    const lowerFacts = facts.toLowerCase();

    let category = "General Civil Litigation";
    let score = 50;
    let issues: string[] = [];
    let scenarios: Scenario[] = [];

    // Deterministic Mock Logic
    if (lowerFacts.includes('contract') || lowerFacts.includes('agreement') || lowerFacts.includes('payment')) {
        category = "Contract Law";
        score = 75;
        issues = ['Breach of Contract', 'Unjust Enrichment', 'Failure to Perform'];
        scenarios = [
            {
                name: 'Summary Judgment',
                probability: 0.60,
                description: 'Clear breach of written terms allows for expedited ruling.',
                recommendedAction: 'File Motion for Summary Judgment immediately.'
            },
            {
                name: 'Settlement',
                probability: 0.30,
                description: 'Defendant may settle to avoid legal fees usually recoverable in contract cases.',
                recommendedAction: 'Send demand letter with 14-day deadline.'
            }
        ];
    } else if (lowerFacts.includes('injury') || lowerFacts.includes('accident') || lowerFacts.includes('medical') || lowerFacts.includes('crash')) {
        category = "Personal Injury / Tort";
        score = 65;
        issues = ['Negligence', 'Causation', 'Damages Assessment'];
        scenarios = [
            {
                name: 'Insurance Settlement',
                probability: 0.80,
                description: 'Insurer likely to offer settlement within policy limits.',
                recommendedAction: 'Compile medical bills and lost wage reports.'
            },
            {
                name: 'Trial on Damages',
                probability: 0.20,
                description: 'Liability admitted, but damages disputed.',
                recommendedAction: 'Retain expert medical witnesses.'
            }
        ];
    } else if (lowerFacts.includes('will') || lowerFacts.includes('estate') || lowerFacts.includes('probate')) {
        category = "Estates & Trusts";
        score = 85;
        issues = ['Testamentary Capacity', 'Undue Influence', 'Asset Distribution'];
        scenarios = [
            {
                name: 'Probate Validation',
                probability: 0.90,
                description: 'Will appears valid on its face.',
                recommendedAction: 'File petition for probate.'
            }
        ];
    } else {
        // Fallback
        score = 45;
        issues = ['Unclear Cause of Action', 'Need More Facts'];
        scenarios = [
            {
                name: 'Investigation Needed',
                probability: 1.0,
                description: 'Facts provided are insufficient to determine specific legal path.',
                recommendedAction: 'Interview client for specific dates and alleged duties.'
            }
        ];
    }

    return {
        viabilityScore: score,
        prediction: score > 60 ? 'Strong Viability' : 'Low/Uncertain Viability',
        scenarios,
        keyIssues: issues,
        caseCategory: category
    };
}
