'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Zap,
  Shield,
  Gauge,
  DollarSign,
  Check,
  Loader2,
  Copy,
  ExternalLink,
  Play,
  Terminal,
  Cpu,
  Sparkles,
  Bot,
  ChevronDown
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

interface DeployResult {
  success: boolean;
  safeToken?: string;
  proxyUrl?: string;
  message?: string;
  error?: string;
  targetProvider?: string;
}

interface ProviderPreset {
  id: string;
  name: string;
  badge: string;
  url: string;
  keyPlaceholder: string;
  defaultModel: string;
  description: string;
}

const PROVIDERS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    badge: 'Official',
    url: 'https://api.openai.com/v1',
    keyPlaceholder: 'sk-proj-... or sk-...',
    defaultModel: 'gpt-4o',
    description: 'GPT-4o, GPT-4o-mini, o1',
  },
  {
    id: 'groq',
    name: 'Groq Cloud',
    badge: 'Ultra Fast',
    url: 'https://api.groq.com/openai/v1',
    keyPlaceholder: 'gsk_...',
    defaultModel: 'llama-3.3-70b-versatile',
    description: 'Llama 3.3 70B, Mixtral 8x7B',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    badge: 'Google AI Studio',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyPlaceholder: 'AIzaSy...',
    defaultModel: 'gemini-1.5-flash',
    description: 'Gemini 1.5 Flash, Gemini 1.5 Pro',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    badge: 'Claude 3.5',
    url: 'https://api.anthropic.com/v1',
    keyPlaceholder: 'sk-ant-api...',
    defaultModel: 'claude-3-5-sonnet-20241022',
    description: 'Claude 3.5 Sonnet, Haiku',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    badge: 'Reasoning',
    url: 'https://api.deepseek.com/v1',
    keyPlaceholder: 'sk-...',
    defaultModel: 'deepseek-chat',
    description: 'DeepSeek-V3, DeepSeek-R1',
  },
  {
    id: 'custom',
    name: 'Custom Endpoint',
    badge: 'Self-Hosted',
    url: '',
    keyPlaceholder: 'Enter custom API key...',
    defaultModel: 'default-model',
    description: 'Ollama, vLLM, or custom proxy',
  },
];

export default function AgentControllerPage() {
  const [selectedProvider, setSelectedProvider] = useState<string>('openai');
  const [formData, setFormData] = useState<{
    targetApiUrl: string;
    rawApiKey: string;
    rateLimit: number;
    spendLimit: number | string;
  }>({
    targetApiUrl: 'https://api.openai.com/v1',
    rawApiKey: '',
    rateLimit: 10,
    spendLimit: '',
  });

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DeployResult | null>(null);
  const [copied, setCopied] = useState('');

  // Interactive agent tester state
  const [testPrompt, setTestPrompt] = useState('Hello AI! Help me negotiate this agreement.');
  const [testModel, setTestModel] = useState('gpt-4o');
  const [testLoading, setTestLoading] = useState(false);
  const [testResponse, setTestResponse] = useState<any>(null);

  const handleSelectProvider = (presetId: string) => {
    const preset = PROVIDERS.find(p => p.id === presetId);
    if (!preset) return;
    setSelectedProvider(preset.id);
    if (preset.id !== 'custom') {
      setFormData(prev => ({ ...prev, targetApiUrl: preset.url }));
      setTestModel(preset.defaultModel);
    } else {
      setFormData(prev => ({ ...prev, targetApiUrl: '' }));
      setTestModel('default-model');
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target as HTMLInputElement;
    if (name === 'spendLimit') {
      setFormData({ ...formData, spendLimit: value === '' ? '' : Number(value) });
    } else if (type === 'number') {
      setFormData({ ...formData, [name]: Number(value) });
    } else {
      setFormData({ ...formData, [name]: value });
    }
  };

  const handleDeploy = async () => {
    if (!formData.rawApiKey) return alert('Please enter your API Key!');
    if (!formData.targetApiUrl.trim()) return alert('Please enter or select a Target API URL!');
    setLoading(true);
    setResult(null);
    setTestResponse(null);

    const payload = {
      ...formData,
      provider: selectedProvider,
      spendLimit: formData.spendLimit === '' ? null : Number(formData.spendLimit),
    };

    try {
      const res = await fetch('/api/deploy-latch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      setResult(data);
    } catch (error) {
      setResult({ success: false, error: 'Deployment failed. Check console.' });
      console.error(error);
    }
    setLoading(false);
  };

  const handleTestAgent = async () => {
    if (!result?.safeToken) return;
    setTestLoading(true);
    setTestResponse(null);

    try {
      const res = await fetch('/api/proxy/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${result.safeToken}`,
        },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: 'user', content: testPrompt }],
          targetApiUrl: formData.targetApiUrl,
          provider: selectedProvider,
        }),
      });
      const data = await res.json();
      setTestResponse(data);
    } catch (err: any) {
      setTestResponse({ error: err?.message || 'Failed to query proxy' });
    }
    setTestLoading(false);
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const activePreset = PROVIDERS.find(p => p.id === selectedProvider) || PROVIDERS[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Cpu className="text-blue-500" size={26} /> Agent Controller
        </h1>
        <p className="text-zinc-400 text-sm mt-1">
          Deploy AI agents with secure key management and set boundaries in one click for OpenAI, Groq, Gemini & custom APIs.
        </p>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Main Deploy Form */}
        <Card className="lg:col-span-2 border-zinc-800/80 bg-zinc-900/40">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg text-white">Deploy Agent with Latch</CardTitle>
                <CardDescription>Secure your keys and set agent boundaries</CardDescription>
              </div>
              <Badge variant="info" className="gap-1"><Shield size={12} /> Secured Proxy</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Quick Provider Selection Buttons */}
            <div className="space-y-2">
              <label className="text-xs text-zinc-400 font-medium uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles size={13} className="text-blue-400" /> Choose AI Provider (Auto-fills Target URL)
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {PROVIDERS.map((preset) => {
                  const isSelected = selectedProvider === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handleSelectProvider(preset.id)}
                      className={`p-3 rounded-xl text-xs font-medium border transition-all text-left flex flex-col gap-1 ${
                        isSelected
                          ? `bg-blue-600/20 border-blue-500 text-white shadow-lg shadow-blue-500/15`
                          : `bg-zinc-800/40 border-zinc-700/60 text-zinc-400 hover:text-white hover:border-zinc-500`
                      }`}
                    >
                      <div className="flex items-center justify-between w-full">
                        <span className="font-semibold text-zinc-200">{preset.name}</span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{preset.badge}</span>
                      </div>
                      <span className="text-[10px] text-zinc-500 truncate">{preset.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Target API URL Select & Input */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Target API URL</label>
                <span className="text-[10px] text-blue-400 font-mono">
                  Active: {activePreset.name}
                </span>
              </div>

              {/* Quick Dropdown Preset Selector */}
              <div className="relative">
                <select
                  value={selectedProvider}
                  onChange={(e) => handleSelectProvider(e.target.value)}
                  className="w-full bg-zinc-800/80 border border-zinc-700/70 rounded-xl px-4 py-2.5 text-xs text-white outline-none cursor-pointer appearance-none pr-10 focus:border-blue-500/50"
                >
                  <option value="openai">OpenAI Official — https://api.openai.com/v1</option>
                  <option value="groq">Groq Cloud (Ultra Fast) — https://api.groq.com/openai/v1</option>
                  <option value="gemini">Google Gemini (AI Studio) — https://generativelanguage.googleapis.com/v1beta/openai</option>
                  <option value="anthropic">Anthropic Claude — https://api.anthropic.com/v1</option>
                  <option value="deepseek">DeepSeek AI — https://api.deepseek.com/v1</option>
                  <option value="custom">Custom Endpoint (Type your own below)</option>
                </select>
                <ChevronDown size={14} className="absolute right-3.5 top-3.5 text-zinc-400 pointer-events-none" />
              </div>

              {/* Exact URL Input Box (Editable) */}
              <div className="flex items-center gap-2 bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-4 py-2.5 focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/20 transition-all">
                <ExternalLink size={14} className="text-zinc-500 shrink-0" />
                <input
                  type="text"
                  name="targetApiUrl"
                  value={formData.targetApiUrl}
                  onChange={handleChange}
                  placeholder="https://api.openai.com/v1"
                  className="flex-1 bg-transparent text-xs sm:text-sm text-white placeholder:text-zinc-500 outline-none font-mono"
                />
              </div>
            </div>

            {/* Raw API Key */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs text-zinc-400 font-medium uppercase tracking-wider">
                  Your Raw API Key ({activePreset.name})
                </label>
                <span className="text-[10px] text-zinc-500">Secured & encrypted in Latch token</span>
              </div>
              <div className="flex items-center gap-2 bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-4 py-2.5 focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/20 transition-all">
                <Shield size={14} className="text-zinc-500 shrink-0" />
                <input
                  type="password"
                  name="rawApiKey"
                  value={formData.rawApiKey}
                  onChange={handleChange}
                  placeholder={activePreset.keyPlaceholder}
                  className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none font-mono"
                />
              </div>
            </div>

            {/* Rate Limit & Spend Limit */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Rate Limit (Req/min)</label>
                <div className="flex items-center gap-2 bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-4 py-2.5 focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/20 transition-all">
                  <Gauge size={14} className="text-zinc-500 shrink-0" />
                  <input
                    type="number"
                    name="rateLimit"
                    value={formData.rateLimit}
                    onChange={handleChange}
                    className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Spend Limit ($)</label>
                  <span className="text-[10px] text-zinc-500 lowercase">optional</span>
                </div>
                <div className="flex items-center gap-2 bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-4 py-2.5 focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/20 transition-all">
                  <DollarSign size={14} className="text-zinc-500 shrink-0" />
                  <input
                    type="number"
                    name="spendLimit"
                    value={formData.spendLimit}
                    onChange={handleChange}
                    placeholder="e.g. 50 (optional)"
                    className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Deploy Button */}
            <Button
              onClick={handleDeploy}
              disabled={loading || !formData.rawApiKey}
              className="w-full gap-2 py-5 text-base bg-blue-600 hover:bg-blue-500 transition-all shadow-lg shadow-blue-600/20"
            >
              {loading ? (
                <><Loader2 size={18} className="animate-spin" /> Deploying with Latch...</>
              ) : (
                <><Zap size={18} /> One-Click Deploy ({activePreset.name})</>
              )}
            </Button>

            {/* Result */}
            {result && result.success && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-5 rounded-xl border border-green-500/20 bg-green-600/10 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Check size={18} className="text-green-400" />
                    <span className="text-sm font-medium text-green-400">Deployment Successful! ✅</span>
                  </div>
                  <Badge variant="outline" className="text-green-400 border-green-500/30 text-xs">
                    Target: {activePreset.name}
                  </Badge>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400">Proxy URL</span>
                    <button onClick={() => copyToClipboard(result.proxyUrl || '', 'proxy')} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                      <Copy size={12} /> {copied === 'proxy' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <code className="block text-xs text-zinc-300 bg-zinc-800/80 rounded-lg p-2.5 break-all font-mono">
                    {result.proxyUrl || 'https://onlatch.com/proxy/v1/...'}
                  </code>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-400">Safe Token (lat_...)</span>
                    <button onClick={() => copyToClipboard(result.safeToken || '', 'token')} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                      <Copy size={12} /> {copied === 'token' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <code className="block text-xs text-green-300 bg-zinc-800/80 rounded-lg p-2.5 break-all font-mono font-semibold">
                    {result.safeToken}
                  </code>
                </div>

                {/* Live Test Console */}
                <div className="mt-4 pt-4 border-t border-green-500/20 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                      <Terminal size={14} className="text-blue-400" /> Test Agent with Safe Token ({activePreset.name})
                    </span>
                    <Badge variant="outline" className="text-[10px] text-green-400 border-green-500/30">Live Test</Badge>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div className="sm:col-span-2">
                      <input
                        type="text"
                        value={testPrompt}
                        onChange={(e) => setTestPrompt(e.target.value)}
                        placeholder="Prompt to send to agent..."
                        className="w-full bg-zinc-900 border border-zinc-700/60 rounded-lg px-3 py-2 text-xs text-white outline-none"
                      />
                    </div>
                    <div>
                      <input
                        type="text"
                        value={testModel}
                        onChange={(e) => setTestModel(e.target.value)}
                        placeholder="Model name"
                        className="w-full bg-zinc-900 border border-zinc-700/60 rounded-lg px-3 py-2 text-xs text-zinc-300 font-mono outline-none"
                      />
                    </div>
                  </div>

                  <Button size="sm" onClick={handleTestAgent} disabled={testLoading} className="w-full gap-1.5 py-2 text-xs">
                    {testLoading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Run Agent ({testModel})
                  </Button>

                  {testResponse && (
                    <div className="bg-zinc-950/80 border border-zinc-800 p-3 rounded-lg text-xs space-y-1.5">
                      <div className="text-zinc-400 flex items-center justify-between">
                        <span className="font-semibold text-zinc-300 flex items-center gap-1">
                          <Bot size={13} className="text-blue-400" /> Agent Response:
                        </span>
                        <span className="text-[10px] text-green-400">Status: 200 OK</span>
                      </div>
                      <p className="text-zinc-200 font-mono text-[11px] bg-zinc-900 p-2 rounded border border-zinc-800/80">
                        {testResponse.choices?.[0]?.message?.content || JSON.stringify(testResponse)}
                      </p>
                    </div>
                  )}
                </div>

                <p className="text-[11px] text-zinc-400">
                  Give this token to your AI agent. It can no longer access your raw {activePreset.name} API key!
                </p>
              </motion.div>
            )}

            {result && !result.success && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-4 rounded-xl border border-red-500/20 bg-red-600/10"
              >
                <p className="text-sm text-red-400">{result.error || 'Deployment failed.'}</p>
              </motion.div>
            )}
          </CardContent>
        </Card>

        {/* Sidebar Info */}
        <div className="space-y-6">
          <Card className="border-zinc-800/80 bg-zinc-900/40">
            <CardHeader>
              <CardTitle className="text-base text-white">Supported Target APIs</CardTitle>
              <CardDescription>Works universally with all OpenAI-compatible endpoints</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                {PROVIDERS.filter(p => p.id !== 'custom').map((p) => (
                  <div key={p.id} className="p-2.5 rounded-lg bg-zinc-800/30 border border-zinc-800 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-zinc-200">{p.name}</div>
                      <div className="text-[10px] text-zinc-500 font-mono truncate max-w-[200px]">{p.url}</div>
                    </div>
                    <Badge variant="outline" className="text-[9px] text-blue-400 border-blue-500/20">
                      {p.defaultModel}
                    </Badge>
                  </div>
                ))}
              </div>

              <Separator className="bg-zinc-800" />

              <div className="p-3 rounded-lg bg-blue-600/10 border border-blue-500/20">
                <div className="flex items-center gap-2 text-xs font-medium text-blue-400 mb-1">
                  <Shield size={13} />
                  Secure Key Wrapping
                </div>
                <p className="text-xs text-zinc-300">
                  Your raw API key is wrapped by Latch into a safe token (<code className="text-blue-300 font-mono">lat_...</code>).
                  The AI agent only uses the proxy token.
                </p>
              </div>

              <Separator className="bg-zinc-800" />

              <div>
                <h4 className="text-xs text-zinc-500 font-medium uppercase tracking-wider mb-2">Example cURL</h4>
                <code className="block text-[11px] text-zinc-400 bg-zinc-950 p-3 rounded-lg break-all font-mono leading-relaxed border border-zinc-800">
                  {`curl -X POST https://onlatch.com/proxy/v1/chat/completions \\
  -H "Authorization: Bearer ${result?.safeToken || 'lat_123456789abcde'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${testModel || 'gpt-4o'}",
    "messages": [{"role": "user", "content": "Hello AI!"}]
  }'`}
                </code>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
