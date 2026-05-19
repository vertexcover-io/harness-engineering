import axios from "axios";

export class SearchTool {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async run(query: string): Promise<{ results: any[]; total: number }> {
    const response = await axios.get(`${this.baseUrl}/search`, {
      params: { q: query },
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    return { results: response.data.items, total: response.data.total };
  }

  getDescription(): string {
    return "Searches the knowledge base for relevant documents";
  }
}
