'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Zap, Shield, Gauge, DollarSign, Check, Loader2, Copy, ExternalLink, Play, Terminal } from 'lucide-react';
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
}

export default function AgentControllerPage() {
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
  const [testLoading, setTestLoading] = useState(false);
  const [testResponse, setTestResponse] = useState<any>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type } = e.target;
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
    setLoading(true);
    setResult(null);
    setTestResponse(null);

    const payload = {
      ...formData,
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
          model: 'gpt-4',
          messages: [{ role: 'user', content: testPrompt }],
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Agent Controller</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Deploy AI agents with secure key management and set boundaries in one click.
        </p>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Main Deploy Form */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Deploy Agent with Latch</CardTitle>
                <CardDescription>Secure your keys and set agent boundaries</CardDescription>
              </div>
              <Badge variant="info" className="gap-1"><Shield size={12} /> Secured</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Target API URL */}
            <div className="space-y-2">
              <label className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Target API URL</label>
              <div className="flex items-center gap-2 bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-4 py-2.5 focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/20 transition-all">
                <ExternalLink size={14} className="text-zinc-500 shrink-0" />
                <input
                  type="text"
                  name="targetApiUrl"
                  value={formData.targetApiUrl}
                  onChange={handleChange}
                  placeholder="Target API (e.g., https://api.openai.com/v1)"
                  className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none"
                />
              </div>
            </div>

            {/* Raw API Key */}
            <div className="space-y-2">
              <label className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Your Raw API Key</label>
              <div className="flex items-center gap-2 bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-4 py-2.5 focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/20 transition-all">
                <Shield size={14} className="text-zinc-500 shrink-0" />
                <input
                  type="password"
                  name="rawApiKey"
                  value={formData.rawApiKey}
                  onChange={handleChange}
                  placeholder="Your Raw API Key (sk-...)"
                  className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none"
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
              className="w-full gap-2 py-5 text-base"
            >
              {loading ? (
                <><Loader2 size={18} className="animate-spin" /> Deploying with Latch...</>
              ) : (
                <><Zap size={18} /> One-Click Deploy</>
              )}
            </Button>

            {/* Result */}
            {result && result.success && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-5 rounded-xl border border-green-500/20 bg-green-600/10 space-y-4"
              >
                <div className="flex items-center gap-2">
                  <Check size={18} className="text-green-400" />
                  <span className="text-sm font-medium text-green-400">Deployment Successful! ✅</span>
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
                      <Terminal size={14} className="text-blue-400" /> Test Agent with Safe Token
                    </span>
                    <Badge variant="outline" className="text-[10px] text-green-400 border-green-500/30">Live Test</Badge>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={testPrompt}
                      onChange={(e) => setTestPrompt(e.target.value)}
                      placeholder="Prompt to send to agent..."
                      className="flex-1 bg-zinc-900 border border-zinc-700/60 rounded-lg px-3 py-2 text-xs text-white outline-none"
                    />
                    <Button size="sm" onClick={handleTestAgent} disabled={testLoading} className="gap-1.5 shrink-0">
                      {testLoading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Run Agent
                    </Button>
                  </div>

                  {testResponse && (
                    <div className="bg-zinc-950/80 border border-zinc-800 p-3 rounded-lg text-xs space-y-1.5">
                      <div className="text-zinc-400 flex items-center justify-between">
                        <span>Response from Agent Proxy:</span>
                        <span className="text-[10px] text-green-400">Status: 200 OK</span>
                      </div>
                      <p className="text-zinc-200 font-mono text-[11px] bg-zinc-900 p-2 rounded border border-zinc-800/80">
                        {testResponse.choices?.[0]?.message?.content || JSON.stringify(testResponse)}
                      </p>
                    </div>
                  )}
                </div>

                <p className="text-[11px] text-zinc-400">
                  Give this token to your AI agent. It can no longer access your raw API key!
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
          <Card>
            <CardHeader>
              <CardTitle>How It Works</CardTitle>
              <CardDescription>Latch key management</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-3 rounded-lg bg-blue-600/10 border border-blue-500/20">
                <div className="flex items-center gap-2 text-sm text-blue-400 mb-1">
                  <Shield size={14} />
                  Secure Key Wrapping
                </div>
                <p className="text-sm text-zinc-300">
                  Your raw API key is sent to Latch, which wraps it in a secure proxy token (<code className="text-blue-300">lat_...</code>). 
                  Your AI agent only sees the safe token — never the real key.
                </p>
              </div>

              <Separator />

              <div className="space-y-3">
                <h4 className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Steps</h4>
                {[
                  { step: '1', text: 'Enter your API key & set limits' },
                  { step: '2', text: 'Latch creates a secure proxy token' },
                  { step: '3', text: 'Use the safe token in your AI agent' },
                  { step: '4', text: 'Latch enforces rate & spend limits' },
                ].map((item) => (
                  <div key={item.step} className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-full bg-blue-600/20 text-blue-400 flex items-center justify-center text-xs font-bold shrink-0">
                      {item.step}
                    </span>
                    <span className="text-sm text-zinc-400">{item.text}</span>
                  </div>
                ))}
              </div>

              <Separator />

              <div>
                <h4 className="text-xs text-zinc-500 font-medium uppercase tracking-wider mb-3">Example cURL</h4>
                <code className="block text-[11px] text-zinc-400 bg-zinc-800/50 rounded-lg p-3 break-all leading-relaxed font-mono">
                  {`curl -X POST https://onlatch.com/proxy/v1/chat/completions \\
  -H "Authorization: Bearer ${result?.safeToken || 'lat_123456789abcde'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4",
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
