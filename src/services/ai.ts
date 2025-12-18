
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Interface matching core/viability.ts CaseAnalysis
export interface AIAnalysisResult {
    viabilityScore: number;
    prediction: string;
    scenarios: {
        name: string;
        probability: number;
        description: string;
        recommendedAction: string;
    }[];
    keyIssues: string[];
    caseCategory: string;
}

export class AIService {
    private openai?: OpenAI;
    private gemini?: any; // GoogleGenerativeAI type
    private provider: 'openai' | 'gemini' | 'none' = 'none';

    constructor() {
        if (process.env.OPENAI_API_KEY) {
            this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            this.provider = 'openai';
            console.log('[AI] Initialized with OpenAI.');
        } else if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
            const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
            this.gemini = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            this.provider = 'gemini';
            console.log('[AI] Initialized with Google Gemini.');
        } else {
            console.warn('[AI] No API Key found. Using fallback mock logic.');
        }
    }

    async analyzeLegalText(text: string): Promise<AIAnalysisResult> {
        if (this.provider === 'none') throw new Error("No AI Provider");

        const prompt = `
        You are a Senior Legal Consultant providing a comprehensive case analysis.
        
        DOCUMENT CONTENT:
        """
        ${text.substring(0, 20000)}
        """

        TASK: Provide a thorough legal analysis of this document. Be specific, practical, and actionable.

        REQUIREMENTS:
        1. Identify the core legal matter and categorize it accurately.
        2. Assess the viability score (0-100) based on evidence strength, legal precedent, and procedural standing.
        3. Identify 3-5 key legal issues with specificity (cite relevant laws/principles if apparent).
        4. Provide realistic scenarios with probability assessments.
        5. Give actionable recommendations a lawyer would actually use.

        OUTPUT FORMAT (JSON only, no markdown wrappers):
        {
            "viabilityScore": number (0-100),
            "prediction": "Strong" | "Moderate" | "Weak",
            "caseCategory": "Contract" | "Tort" | "Criminal" | "Family" | "Property" | "Employment" | "Corporate" | "Other",
            "keyIssues": ["Specific issue 1", "Specific issue 2", "..."],
            "scenarios": [
                {
                    "name": "Favorable Outcome",
                    "probability": 0.0-1.0,
                    "description": "Detailed description of this scenario",
                    "recommendedAction": "Specific action to take"
                },
                {
                    "name": "Unfavorable Outcome",
                    "probability": 0.0-1.0,
                    "description": "Detailed description of this scenario",
                    "recommendedAction": "Specific action to mitigate"
                }
            ]
        }
        `;

        let rawResponse = '';

        try {
            if (this.provider === 'openai') {
                const completion = await this.openai!.chat.completions.create({
                    messages: [{ role: "system", content: "You are a legal expert returning raw JSON." }, { role: "user", content: prompt }],
                    model: "gpt-4o-mini", // Fallback to 3.5-turbo if needed, but strict mode prefers 4o usually or 3.5. Assuming 4o-mini is available/valid.
                    response_format: { type: "json_object" }
                });
                rawResponse = completion.choices[0].message.content || '{}';
            } else if (this.provider === 'gemini') {
                const result = await this.gemini.generateContent(prompt);
                const response = await result.response;
                rawResponse = response.text();
                // Clean markdown code blocks if Gemini sends them
                rawResponse = rawResponse.replace(/```json/g, '').replace(/```/g, '');
            }

            return JSON.parse(rawResponse);

        } catch (error) {
            console.error('[AI] Analysis Failed:', error);
            // Fallback
            return {
                viabilityScore: 50,
                prediction: "Error",
                caseCategory: "Unknown",
                keyIssues: ["AI Analysis Failed"],
                scenarios: []
            };
        }
    }

    async askAI(context: string, question: string): Promise<string> {
        if (this.provider === 'none') return "AI Service Unavailable.";

        const prompt = `
        CONTEXT FACTS (Max 20000 chars):
        "${context.substring(0, 20000)}"

        USER QUESTION:
        "${question}"

        Act as a legal assistant. Answer the question based on the facts provided.
        Use professional formatting with clear Bold Headers (e.g., **Analysis**, **Conclusion**).
        Do NOT use phrases like "As an AI" or "Based on the context". Just provide the answer.
        `;

        try {
            if (this.provider === 'openai') {
                const completion = await this.openai!.chat.completions.create({
                    messages: [{ role: "system", content: "You are a legal expert." }, { role: "user", content: prompt }],
                    model: "gpt-4o-mini",
                });
                return completion.choices[0].message.content || "No response.";
            } else if (this.provider === 'gemini') {
                const result = await this.gemini.generateContent(prompt);
                return result.response.text();
            }
            return "Provider Error.";
        } catch (e) {
            console.error('[AI] Q&A Failed:', e);
            return "I'm having trouble analyzing that right now.";
        }
    }

    async runSimulation(facts: string): Promise<string> {
        if (this.provider === 'none') return "Simulation Unavailable.";

        const prompt = `
        Act as a Legal Simulator. Run a simulation of a potential trial based on these facts:
        
        FACTS:
        "${facts.substring(0, 20000)}"

        Output a narrative simulation that covers:
        1. **Judge's Perspective**: Likely rulings on motions.
        2. **Jury Reaction**: How a typical jury might perceive the facts.
        3. **Opposing Counsel Strategy**: Likely defenses or counter-arguments.
        4. **Verdict Prediction**: A probable outcome percentage.

        Format with clear Markdown headers. Be realistic and critical.
        `;

        try {
            if (this.provider === 'openai') {
                const completion = await this.openai!.chat.completions.create({
                    messages: [{ role: "system", content: "You are a legal simulator." }, { role: "user", content: prompt }],
                    model: "gpt-4o-mini",
                });
                return completion.choices[0].message.content || "Simulation failed.";
            } else if (this.provider === 'gemini') {
                const result = await this.gemini.generateContent(prompt);
                return result.response.text();
            }
            return "Provider Error.";
        } catch (e) {
            console.error('[AI] Simulation Failed:', e);
            return "Simulation failed to run.";
        }
    }
    async runInteractiveSimulation(facts: string, inputs: {
        outcome: string,
        evidence: string,
        opposing: string,
        jurisdiction: string,
        caveats: string
    }): Promise<string> {
        if (this.provider === 'none') return "Simulation Unavailable.";

        const prompt = `
        Act as a Legal Simulator. Run a USER-DEFINED simulation based on these specific parameters:

        CASE FACTS:
        "${facts.substring(0, 15000)}"

        SIMULATION PARAMETERS:
        1. TARGET OUTCOME TO TEST: "${inputs.outcome}"
        2. KEY EVIDENCE/WITNESS: "${inputs.evidence}"
        3. OPPOSING STRATEGY: "${inputs.opposing}"
        4. JURISDICTION/JUDGE NUANCES: "${inputs.jurisdiction}"
        5. CAVEATS & COMMENTS: "${inputs.caveats}"

        TASK:
        Simulate the trial or legal proceeding strictly using the above User Inputs as the simulation variables.
        Analyze if the Target Outcome is achievable given the Evidence, Opposing Strategy, and Jurisdiction.
        Address the Caveats specifically.

        OUTPUT FORMAT:
        **Simulation Results**
        
        **1. Analysis of Target Outcome**
        (Is it viable? Why/Why not?)

        **2. Impact of Key Evidence**
        (How does it sway the judge/jury?)

        **3. Counter-Strategy Effectiveness**
        (How effective is the opposing argument?)

        **4. Jurisdiction Factor**
        (How does the specific venue affect the case?)

        **5. Conclusion & Probability**
        (Final assessment based on these constraints)
        `;

        try {
            if (this.provider === 'openai') {
                const completion = await this.openai!.chat.completions.create({
                    messages: [{ role: "system", content: "You are a legal simulator." }, { role: "user", content: prompt }],
                    model: "gpt-4o-mini",
                });
                return completion.choices[0].message.content || "Simulation failed.";
            } else if (this.provider === 'gemini') {
                const result = await this.gemini.generateContent(prompt);
                return result.response.text();
            }
            return "Provider Error.";
        } catch (e) {
            console.error('[AI] Interactive Simulation Failed:', e);
            return "Simulation failed to run.";
        }
    }
}

export const aiService = new AIService();
