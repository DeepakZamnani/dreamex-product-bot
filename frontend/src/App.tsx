'use client';
import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Send, ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

const API_URL = import.meta.env.VITE_API_URL || 'https://dreamex-product-bot-zkml.vercel.app';

interface PropertyImage {
  id: number;
  image_url: string;
}

interface Property {
  broker_id: number;
  property_name: string;
  rera_id: string;
  property_location: string;
  property_city: string;
  property_type: string;
  property_description: string;
  broker_name: string;
  broker_phone: string;
  broker_email: string;
  brochure_url: string | null;
  web_slug: string;
  broker_username: string;
  images: PropertyImage[];
}

interface ChatButton {
  id: string;
  title: string;
  url?: string;
}

interface ChatMessage {
  sender: 'user' | 'ai';
  message: string;
  time: string;
  type?: 'text' | 'buttons' | 'image';
  buttons?: ChatButton[];
  imageUrl?: string;
}

const now = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Mirror of n8n Parse Output node — reconstructs structure from stored raw output
const parseRawMessage = (raw: string): Pick<ChatMessage, 'type' | 'message' | 'imageUrl' | 'buttons'> => {
  const imageMatch = raw.match(/\[IMAGE:\s*(https?:\/\/[^\]]+)\]/i);
  const imageUrl   = imageMatch ? imageMatch[1].trim() : undefined;
  const cleanText  = raw.replace(/\[IMAGE:\s*https?:\/\/[^\]]+\]/gi, '').trim();

  const lines   = cleanText.split('\n').map(l => l.trim()).filter(Boolean);
  const buttons: ChatButton[] = [];
  const bodyLines: string[]   = [];

  for (const line of lines) {
    const m = line.match(/^(\d+)[.)]\s*(.+)/);
    if (m && buttons.length < 10) {
      const title = m[2].replace(/[^\w\sऀ-ॿ\-–+]/g, '').trim().slice(0, 24);
      if (title) buttons.push({ id: `btn_${m[1]}`, title });
    } else {
      bodyLines.push(line);
    }
  }

  const body = bodyLines.join('\n');
  if (imageUrl) return { type: 'image', message: body, imageUrl, buttons };
  if (buttons.length >= 2) return { type: 'buttons', message: body, buttons };
  return { type: 'text', message: cleanText };
};

const URL_REGEX = /(https?:\/\/[^\s<>()]+)/g;

const stripTrailingPunctuation = (url: string) => {
  const trailing = url.match(/[).,!?;:]+$/);
  return trailing ? url.slice(0, -trailing[0].length) : url;
};

// Wraps bare URLs in markdown link syntax so ReactMarkdown renders them clickable
const linkify = (text: string) =>
  text.replace(URL_REGEX, raw => {
    const url = stripTrailingPunctuation(raw);
    const trailing = raw.slice(url.length);
    return `[${url}](${url})${trailing}`;
  });

const extractFirstUrl = (text: string): string | null => {
  const match = text.match(URL_REGEX);
  return match ? stripTrailingPunctuation(match[0]) : null;
};

// Extracts `[BUTTON:Title|https://...]` tags into real link buttons and strips them from the display text
const BUTTON_TAG_REGEX = /\[BUTTON:\s*([^|\]]+?)\s*\|\s*(https?:\/\/[^\]\s]+)\s*\]/gi;

const parseButtonTags = (text: string): { text: string; buttons: ChatButton[] } => {
  const buttons: ChatButton[] = [];
  const stripped = text.replace(BUTTON_TAG_REGEX, (_match, title: string, url: string) => {
    const cleanTitle = title.trim().slice(0, 30);
    if (cleanTitle) buttons.push({ id: `link_${buttons.length}`, title: cleanTitle, url: url.trim() });
    return '';
  });
  const cleaned = stripped
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();
  return { text: cleaned, buttons };
};

const MarkdownLink: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement>> = ({ href, children }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" style={s.waMdLink}>{children}</a>
);
const markdownComponents = { a: MarkdownLink };

const DefaultAvatar: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="9" r="4" fill="#ffffff" fillOpacity="0.85" />
    <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="#ffffff" fillOpacity="0.85" />
  </svg>
);

const TypingDots: React.FC = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '10px 14px' }}>
    {[0, 1, 2].map(i => (
      <span
        key={i}
        style={{
          width: 7, height: 7, borderRadius: '50%',
          backgroundColor: '#667781',
          display: 'inline-block',
          animation: `typingBounce 1.2s ${i * 0.2}s ease-in-out infinite`,
        }}
      />
    ))}
  </div>
);

const App: React.FC = () => {
  const { slug, leadPhone } = useParams<{ slug: string; leadPhone?: string }>();

  const [property, setProperty]       = useState<Property | null>(null);
  const [loadingProp, setLoadingProp] = useState(true);
  const [notFound, setNotFound]       = useState(false);

  const [messages, setMessages]   = useState<ChatMessage[]>([]);
  const [input, setInput]         = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const messagesEndRef    = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);

  // ── fetch property data ───────────────────────────────────────────────────
  useEffect(() => {
    if (!slug) return;
    (async () => {
      try {
        const res  = await fetch(`${API_URL}/api/property/${slug}`);
        const data = await res.json();
        if (!data.success) { setNotFound(true); return; }
        setProperty(data.property);
      } catch {
        setNotFound(true);
      } finally {
        setLoadingProp(false);
      }
    })();
  }, [slug]);

  // ── identified lead: load previous messages ───────────────────────────────
  useEffect(() => {
    if (!slug || !leadPhone) return;
    (async () => {
      try {
        const res  = await fetch(`${API_URL}/api/property/${slug}/${leadPhone}/messages`);
        const data = await res.json();
        if (data.success && data.messages.length > 0) {
          setMessages(data.messages.map((m: { sender: string; message: string; sent_at: string }) => {
            const parsed = m.sender === 'ai' ? parseRawMessage(m.message) : { type: 'text' as const, message: m.message };
            return {
              sender: m.sender as 'user' | 'ai',
              time: new Date(m.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              ...parsed,
            };
          }));
        } else {
          setMessages([]);
        }
      } catch {
        setMessages([]);
      }
    })();
  }, [slug, leadPhone]);

  // ── anonymous mode: get conversation ID ──────────────────────────────────
  useEffect(() => {
    if (!slug || leadPhone) return;
    (async () => {
      try {
        const res  = await fetch(`${API_URL}/api/property/${slug}/conversation`);
        const data = await res.json();
        if (data.success) setConversationId(data.conversationId);
      } catch {
        console.error('Failed to init conversation');
      }
    })();
  }, [slug, leadPhone]);

  // ── welcome message once property is known (no prior history) ────────────
  useEffect(() => {
    if (!property || messages.length > 0) return;
    setMessages([{
      sender: 'ai',
      message: `Hi! 👋 I'm the AI assistant for **${property.property_name}**. Ask me anything about pricing, availability, or amenities.`,
      time: now(),
    }]);
  }, [property, messages.length]);

  // ── auto-scroll (layout-synchronous so it never races against render) ────
  useLayoutEffect(() => {
    const el = messagesScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isLoading]);

  // ── shared send logic ─────────────────────────────────────────────────────
  const doSend = async (text: string) => {
    const ready = leadPhone ? true : !!conversationId;
    if (!text.trim() || !ready || isLoading) return;

    setMessages(prev => [...prev, { sender: 'user', message: text, time: now(), type: 'text' }]);
    setIsLoading(true);

    const identifier = leadPhone || conversationId!;
    const chatUrl    = leadPhone
      ? `${API_URL}/api/property/${slug}/${leadPhone}/chat`
      : `${API_URL}/api/property/${slug}/chat`;

    try {
      const res = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'web',
          conversationId: identifier,
          messageId: `${identifier}_${Date.now()}`,
          from: identifier,
          event: 'message_received',
          contacts: { profileName: 'Visitor', recipient: identifier },
          messages: {
            type: 'text',
            text: { body: text },
            timestamp: Date.now(),
          },
        }),
      });
      const data = await res.json();
      const msgType = data.messageType || 'text';

      if (msgType === 'buttons') {
        setMessages(prev => [...prev, {
          sender: 'ai',
          message: data.body || data.output || '',
          time: now(),
          type: 'buttons',
          buttons: data.buttons || [],
        }]);
      } else if (msgType === 'image') {
        setMessages(prev => [...prev, {
          sender: 'ai',
          message: data.body || data.output || '',
          time: now(),
          type: 'image',
          imageUrl: data.imageUrl,
          buttons: data.buttons || [],
        }]);
      } else {
        setMessages(prev => [...prev, {
          sender: 'ai',
          message: data.output || data.body || 'Sorry, I could not process your request.',
          time: now(),
          type: 'text',
        }]);
      }
    } catch {
      setMessages(prev => [...prev, {
        sender: 'ai',
        message: 'Sorry, something went wrong. Please try again.',
        time: now(),
        type: 'text',
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  // ── send message (from input box) ─────────────────────────────────────────
  const sendMessage = () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    doSend(text);
  };

  // ── send button reply (from interactive buttons) ──────────────────────────
  const sendButtonReply = (title: string) => {
    doSend(title);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  // ── states ────────────────────────────────────────────────────────────────
  if (loadingProp) {
    return (
      <div style={s.fullCenter}>
        <div style={s.spinner} />
      </div>
    );
  }

  if (notFound || !property) {
    return (
      <div style={s.fullCenter}>
        <p style={{ color: '#f0f0f0', fontSize: 18 }}>Property not found.</p>
        <a href="/" style={{ color: '#c9a84c', marginTop: 12, fontSize: 14 }}>← Back to DreamX</a>
      </div>
    );
  }

  // ── Chat Panel (WhatsApp style) ───────────────────────────────────────────
  const ChatPanel = () => (
    <div style={s.chatPanel}>
      {/* WA Header */}
      <div style={s.waHeader}>
        <div style={s.waAvatar}>
          {property?.images?.[0]?.image_url ? (
            <img src={property.images[0].image_url} alt="" style={s.waAvatarImg} />
          ) : (
            <DefaultAvatar />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={s.waHeaderName}>{property?.property_name || 'AI Assistant'}</p>
          <p style={s.waHeaderSub}>online</p>
        </div>
      </div>

      {/* WA Messages area */}
      <div ref={messagesScrollRef} style={s.waMessages}>
        {messages.map((msg, i) => {
          const isBot = msg.sender === 'ai';
          const isGroupStart = i === 0 || messages[i - 1].sender !== msg.sender;
          const tailClass = isGroupStart ? (isBot ? 'wa-bubble-bot' : 'wa-bubble-user') : '';
          const bubbleRadius = isBot
            ? (isGroupStart ? '2px 8px 8px 8px' : '8px 8px 8px 8px')
            : (isGroupStart ? '8px 2px 8px 8px' : '8px 8px 8px 8px');
          const bubbleStyle = {
            ...(isBot ? s.waBubbleBot : s.waBubbleUser),
            borderRadius: bubbleRadius,
          };
          const { text: displayText, buttons: tagButtons } = parseButtonTags(msg.message || '');
          const allButtons = [...(msg.buttons || []), ...tagButtons];
          const linkUrl = displayText ? extractFirstUrl(displayText) : null;
          const ctaBar = linkUrl && (
            <a
              href={linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...s.ctaLink, borderColor: isBot ? '#e9edef' : 'rgba(0,0,0,0.08)' }}
            >
              <ExternalLink size={15} />
              Open Link
            </a>
          );
          return (
            <div key={i} style={{ marginTop: i === 0 ? 0 : isGroupStart ? 10 : 2 }}>
              <div style={{ display: 'flex', justifyContent: isBot ? 'flex-start' : 'flex-end' }}>
                {msg.type === 'image' ? (
                  <div className={tailClass} style={bubbleStyle}>
                    {msg.imageUrl && (
                      <img
                        src={msg.imageUrl}
                        alt="Property"
                        style={{ maxWidth: '100%', borderRadius: 8, display: 'block', marginBottom: displayText ? 6 : 2 }}
                      />
                    )}
                    {displayText && (
                      <div style={s.waBubbleText}>
                        <ReactMarkdown components={markdownComponents}>{linkify(displayText)}</ReactMarkdown>
                      </div>
                    )}
                    <div style={s.waTimeTick}>
                      <span style={s.waBubbleTime}>{msg.time}</span>
                    </div>
                    {ctaBar}
                  </div>
                ) : (
                  <div className={tailClass} style={bubbleStyle}>
                    <div style={s.waBubbleText}>
                      <ReactMarkdown components={markdownComponents}>{linkify(displayText)}</ReactMarkdown>
                    </div>
                    <div style={s.waTimeTick}>
                      <span style={s.waBubbleTime}>{msg.time}</span>
                      {!isBot && (
                        <svg width="14" height="10" viewBox="0 0 16 11" fill="none" style={{ marginLeft: 2 }}>
                          <path d="M1 5.5L5 9.5L15 1" stroke="#53bdeb" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                          <path d="M5 9.5L15 1" stroke="#53bdeb" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" transform="translate(-3,0)"/>
                        </svg>
                      )}
                    </div>
                    {ctaBar}
                  </div>
                )}
              </div>

              {/* Interactive button chips below bot bubble — quick replies send text, link buttons open a URL */}
              {isBot && allButtons.length > 0 && (
                <div style={s.btnChipsWrap}>
                  {allButtons.map((btn, bi) => (
                    btn.url ? (
                      <a
                        key={bi}
                        href={btn.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={s.btnChip}
                      >
                        {btn.title}
                        <ExternalLink size={13} style={s.btnChipIcon} />
                      </a>
                    ) : (
                      <button
                        key={bi}
                        onClick={() => sendButtonReply(btn.title)}
                        disabled={isLoading}
                        style={s.btnChip}
                      >
                        {btn.title}
                      </button>
                    )
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: messages.length ? 10 : 0 }}>
            <div className="wa-bubble-bot" style={{ ...s.waBubbleBot, borderRadius: '2px 8px 8px 8px', padding: '6px 14px' }}>
              <TypingDots />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} style={{ height: 0 }} />
      </div>

      {/* WA Input */}
      <div style={s.waInputArea}>
        <textarea
          className="wa-textarea"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message"
          rows={1}
          disabled={isLoading}
          style={s.waTextarea}
        />
        <button
          onClick={sendMessage}
          disabled={isLoading || !input.trim()}
          style={{
            ...s.waSendBtn,
            background: input.trim() ? '#008069' : '#b2bec3',
            cursor: isLoading || !input.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          <Send size={17} color="#fff" />
        </button>
      </div>
    </div>
  );

  return (
    <>
      <style>{`
        @keyframes typingBounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-6px); opacity: 1; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root { height: 100%; overscroll-behavior-y: none; }
        body { background: #efeae2; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #ccc; border-radius: 4px; }

        /* WhatsApp bubble tails */
        .wa-bubble-bot {
          position: relative;
        }
        .wa-bubble-bot::before {
          content: '';
          position: absolute;
          top: 0; left: -7px;
          width: 0; height: 0;
          border-top: 8px solid #ffffff;
          border-left: 8px solid transparent;
        }
        .wa-bubble-user {
          position: relative;
        }
        .wa-bubble-user::after {
          content: '';
          position: absolute;
          top: 0; right: -7px;
          width: 0; height: 0;
          border-top: 8px solid #d9fdd3;
          border-right: 8px solid transparent;
        }

        .chat-app-shell {
          height: 100vh;
          height: 100dvh;
          width: 100vw;
          overflow: hidden;
        }

        .wa-textarea::placeholder { color: #8696a0; }
      `}</style>

      <div className="chat-app-shell">
        {ChatPanel()}
      </div>
    </>
  );
};

const s: Record<string, React.CSSProperties> = {
  fullCenter: {
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    minHeight: '100vh', background: '#0a0a0f',
  },
  spinner: {
    width: 32, height: 32,
    border: '3px solid #1e1e2e',
    borderTopColor: '#c9a84c',
    borderRadius: '50%',
    animation: 'spin 0.7s linear infinite',
  },

  // WhatsApp chat panel — light theme
  chatPanel: {
    display: 'flex', flexDirection: 'column',
    width: '100%', height: '100%',
    background: '#efeae2',
    fontFamily: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
    overflow: 'hidden',
  },
  waHeader: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '9px 12px',
    paddingTop: 'max(9px, env(safe-area-inset-top))',
    paddingLeft: 'max(12px, env(safe-area-inset-left))',
    paddingRight: 'max(12px, env(safe-area-inset-right))',
    background: '#008069',
    flexShrink: 0,
    boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
    zIndex: 1,
  },
  waAvatar: {
    width: 38, height: 38, borderRadius: '50%',
    background: '#8fa9a3',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
  },
  waAvatarImg: {
    width: '100%', height: '100%', objectFit: 'cover', display: 'block',
  },
  waHeaderName: {
    fontSize: 17, fontWeight: 500, color: '#fff',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  waHeaderSub: {
    fontSize: 13, color: 'rgba(255,255,255,0.85)', marginTop: 1,
    display: 'flex', alignItems: 'center', gap: 5,
  },
  waMessages: {
    flex: 1, overflowY: 'auto',
    padding: '10px 12px',
    display: 'flex', flexDirection: 'column',
    backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23c5b89a' fill-opacity='0.3'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
    backgroundColor: '#efeae2',
  },
  waBubbleBot: {
    maxWidth: '78%',
    background: '#ffffff',
    padding: '6px 7px 8px 9px',
    alignSelf: 'flex-start',
    boxShadow: '0 1px 0.5px rgba(0,0,0,0.13)',
  },
  waBubbleUser: {
    maxWidth: '78%',
    background: '#d9fdd3',
    padding: '6px 7px 8px 9px',
    alignSelf: 'flex-end',
    boxShadow: '0 1px 0.5px rgba(0,0,0,0.13)',
  },
  waMdLink: {
    color: '#039be5',
    textDecoration: 'none',
    wordBreak: 'break-word',
  },
  ctaLink: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 6, marginLeft: -9, marginRight: -7, marginBottom: -8,
    padding: '10px 12px',
    borderTop: '1px solid',
    borderRadius: '0 0 8px 8px',
    color: '#00a5f4',
    fontSize: 14, fontWeight: 600,
    textDecoration: 'none',
    cursor: 'pointer',
  },
  waBubbleText: {
    fontSize: 14, lineHeight: 1.5, color: '#111b21',
  },
  waTimeTick: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2,
    marginTop: 3,
  },
  waBubbleTime: {
    fontSize: 11, color: '#667781',
  },

  waInputArea: {
    display: 'flex', alignItems: 'flex-end', gap: 8,
    padding: '8px 10px',
    paddingBottom: 'max(8px, env(safe-area-inset-bottom))',
    paddingLeft: 'max(10px, env(safe-area-inset-left))',
    paddingRight: 'max(10px, env(safe-area-inset-right))',
    background: '#f0f2f5',
    flexShrink: 0,
    borderTop: '1px solid #e9edef',
  },
  waTextarea: {
    flex: 1,
    background: '#ffffff',
    border: 'none',
    borderRadius: 20,
    color: '#111b21',
    fontSize: 16,
    padding: '9px 16px',
    resize: 'none',
    outline: 'none',
    fontFamily: 'inherit',
    lineHeight: 1.4,
    maxHeight: 100,
    boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
  },
  waSendBtn: {
    width: 44, height: 44, borderRadius: '50%',
    border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    transition: 'background 0.2s',
  },

  // Interactive button chips (WhatsApp reply buttons style)
  btnChipsWrap: {
    display: 'flex', flexDirection: 'column', gap: 6,
    alignItems: 'flex-start',
    marginLeft: 8, marginTop: 5, marginBottom: 4,
    maxWidth: '78%',
  },
  btnChip: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    background: '#ffffff',
    border: '1.5px solid #008069',
    borderRadius: 20,
    color: '#008069',
    fontSize: 13, fontWeight: 600,
    padding: '8px 18px',
    cursor: 'pointer',
    fontFamily: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
    boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
    textAlign: 'left' as const,
    textDecoration: 'none',
    wordBreak: 'break-word' as const,
    lineHeight: 1.4,
    width: '100%',
    transition: 'background 0.15s, color 0.15s',
  },
  btnChipIcon: {
    flexShrink: 0,
  },
};

export default App;
