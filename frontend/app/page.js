"use client";

import React, { useState, useEffect, useRef } from "react";
import io from "socket.io-client";
import {
  MessageSquare,
  Users,
  Search,
  Settings,
  Send,
  Power,
  Shield,
  Code,
  Info,
  Trash2,
  Plus,
  X,
  Server,
  User,
  Check,
  CheckCheck,
  ArrowLeft,
  Menu
} from "lucide-react";

// API endpoints Configuration
const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, "");
const SOCKET_URL = (process.env.NEXT_PUBLIC_SOCKET_URL || API_BASE).replace(/\/$/, "");

export default function Home() {
  // Authentication states
  const [token, setToken] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [authMode, setAuthMode] = useState("login"); // 'login' | 'register'
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");

  // Chat core states
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [messages, setMessages] = useState({}); // conversationId -> array of messages
  const [composerText, setComposerText] = useState("");
  const [isCodeMode, setIsCodeMode] = useState(false);
  const [usersList, setUsersList] = useState([]); // All users for starting new chat

  // Stream creation states
  const [newStreamName, setNewStreamName] = useState("");
  const [selectedUsersForStream, setSelectedUsersForStream] = useState([]);

  // Presence and typing states (ephemeral)
  const [presence, setPresence] = useState({}); // userId -> 'online' | 'offline'
  const [typingStates, setTypingStates] = useState({}); // conversationId -> { userId: username }
  const [socketConnected, setSocketConnected] = useState(false);
  const [socketNode, setSocketNode] = useState("Node_01_PROD");

  // Search states
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);

  // Modals & Panels
  const [activeModal, setActiveModal] = useState(null); // 'admin' | 'new_chat' | null
  const [adminStats, setAdminStats] = useState(null);
  const [adminUsers, setAdminUsers] = useState([]);
  const [showDetailPanel, setShowDetailPanel] = useState(true);

  // Refs
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const isTypingRef = useRef(false);
  const activeConversationRef = useRef(null);

  useEffect(() => {
    activeConversationRef.current = activeConversation;
  }, [activeConversation]);

  // Initialize Auth
  useEffect(() => {
    const savedToken = localStorage.getItem("stackchat_token");
    const savedUser = localStorage.getItem("stackchat_user");
    if (savedToken && savedUser) {
      setToken(savedToken);
      setCurrentUser(JSON.parse(savedUser));
    }
  }, []);

  // Fetch conversations and user list once authenticated
  useEffect(() => {
    if (token) {
      fetchConversations();
      fetchUsers();
    }
  }, [token]);

  // Connect WebSockets when authenticated
  useEffect(() => {
    if (!token || !currentUser) return;

    // Establish WebSocket Connection
    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ["websocket", "polling"],
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setSocketConnected(true);
      socket.emit("join_conversations");
      // Request active node identifier from connection details if needed
      setSocketNode(process.env.NEXT_PUBLIC_NODE_ID || "Node_01_PROD");
    });

    socket.on("disconnect", () => {
      setSocketConnected(false);
    });

    // Handle incoming messages
    socket.on("new_message", (message) => {
      console.log("Client received new_message event:", message);
      const { conversation_id } = message;
      setMessages((prev) => ({
        ...prev,
        [conversation_id]: [...(prev[conversation_id] || []), message]
      }));

      const currentActive = activeConversationRef.current;
      const isMe = message.sender_id === currentUser.id;
      const isActive = currentActive && currentActive.id === conversation_id;

      // Update conversations list max sequence and read status dynamically
      setConversations((prevConvs) =>
        prevConvs.map((c) => {
          if (c.id === conversation_id) {
            const newSeq = Math.max(c.max_sequence_id, message.sequence_id);
            return {
              ...c,
              max_sequence_id: newSeq,
              last_read_seq: (isMe || isActive) ? newSeq : c.last_read_seq
            };
          }
          return c;
        })
      );

      // Keep activeConversation state in sync
      if (isActive) {
        setActiveConversation((prev) => {
          if (!prev) return null;
          const newSeq = Math.max(prev.max_sequence_id, message.sequence_id);
          return {
            ...prev,
            max_sequence_id: newSeq,
            last_read_seq: newSeq
          };
        });
      }

      // If active conversation is this one, automatically update read receipt for other sender
      if (isActive && !isMe) {
        socket.emit("read_receipt", {
          conversationId: conversation_id,
          sequenceId: message.sequence_id
        });
      }
    });

    // Handle dynamically created rooms in real-time
    socket.on("conversation_created", (newRoom) => {
      setConversations((prev) => {
        if (prev.some((c) => c.id === newRoom.id)) return prev;
        return [newRoom, ...prev];
      });
      fetchMessages(newRoom.id);
      socket.emit("join_room", newRoom.id);
    });

    // Handle user status updates (online/offline presence)
    socket.on("user_status_changed", (data) => {
      const { userId, status } = data;
      setPresence((prev) => ({ ...prev, [userId]: status }));
    });

    // Handle typing status relays
    socket.on("typing:status", (data) => {
      const { conversationId, userId, username, isTyping } = data;
      setTypingStates((prev) => {
        const convTyping = { ...(prev[conversationId] || {}) };
        if (isTyping) {
          convTyping[userId] = username;
        } else {
          delete convTyping[userId];
        }
        return { ...prev, [conversationId]: convTyping };
      });
    });

    // Handle updated read cursors
    socket.on("read_receipt_updated", (data) => {
      const { conversationId, userId, lastReadSeq } = data;
      setConversations((prevConvs) =>
        prevConvs.map((conv) => {
          if (conv.id === conversationId) {
            const updatedParticipants = conv.participants.map((p) =>
              p.id === userId ? { ...p, last_read_seq: lastReadSeq } : p
            );
            return { ...conv, participants: updatedParticipants };
          }
          return conv;
        })
      );

      // Keep activeConversation participants cursors in sync
      setActiveConversation((prev) => {
        if (prev && prev.id === conversationId) {
          const updatedParticipants = prev.participants.map((p) =>
            p.id === userId ? { ...p, last_read_seq: lastReadSeq } : p
          );
          return { ...prev, participants: updatedParticipants };
        }
        return prev;
      });
    });

    // Handle admin force disconnect signal
    socket.on("admin_disconnect_user", (userId) => {
      if (currentUser.id === userId) {
        handleLogout();
      }
    });

    // Handle real-time conversation deletion
    socket.on("conversation_deleted", (data) => {
      const { conversationId } = data;
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      setActiveConversation((prev) => (prev && prev.id === conversationId ? null : prev));
    });

    // Handle leaving conversations
    socket.on("conversation_left", (data) => {
      const { conversationId } = data;
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      setActiveConversation((prev) => (prev && prev.id === conversationId ? null : prev));
    });

    // Handle updates to conversation participants list
    socket.on("participants_updated", (data) => {
      const { conversationId, room } = data;
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, participants: room.participants } : c))
      );
      setActiveConversation((prev) => {
        if (prev && prev.id === conversationId) {
          return { ...prev, participants: room.participants };
        }
        return prev;
      });
    });

    // Setup heartbeat check every 10 seconds
    const heartbeatInterval = setInterval(() => {
      socket.emit("heartbeat");
    }, 10000);

    return () => {
      socket.disconnect();
      clearInterval(heartbeatInterval);
    };
  }, [token, currentUser]);

  // Scroll to bottom of message feeds
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeConversation, typingStates]);

  // Join socket room explicitly when active conversation changes
  useEffect(() => {
    if (activeConversation && socketRef.current) {
      console.log("Client explicitly joining active room:", activeConversation.id);
      socketRef.current.emit("join_room", activeConversation.id);
    }
  }, [activeConversation]);

  // Fetch messages lazy loading when active conversation changes
  useEffect(() => {
    if (activeConversation) {
      fetchMessages(activeConversation.id);
    }
  }, [activeConversation?.id]);

  // Send read cursor update when active conversation changes or new messages arrive
  useEffect(() => {
    if (!activeConversation || !socketRef.current || !currentUser) return;
    const conversationId = activeConversation.id;
    const convMsgs = messages[conversationId] || [];
    if (convMsgs.length === 0) return;

    // Find highest sequence from others
    const highestOtherSeq = convMsgs
      .filter((m) => m.sender_id !== currentUser.id)
      .reduce((max, m) => Math.max(max, m.sequence_id), 0);

    if (highestOtherSeq > Number(activeConversation.last_read_seq || 0)) {
      socketRef.current.emit("read_receipt", {
        conversationId,
        sequenceId: highestOtherSeq
      });
      // Update local conversation representation
      setConversations((prevConvs) =>
        prevConvs.map((c) =>
          c.id === conversationId ? { ...c, last_read_seq: highestOtherSeq } : c
        )
      );
      // Update activeConversation state to avoid stale check cycles
      setActiveConversation((prev) =>
        prev && prev.id === conversationId ? { ...prev, last_read_seq: highestOtherSeq } : prev
      );
    }
  }, [activeConversation, messages]);

  // REST API: Register/Login
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError("");

    if (!authUsername || !authPassword) {
      setAuthError("All fields are required");
      return;
    }

    try {
      const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: authUsername, password: authPassword })
      });

      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || "Authentication failed");
        return;
      }

      localStorage.setItem("stackchat_token", data.token);
      localStorage.setItem("stackchat_user", JSON.stringify(data.user));
      setToken(data.token);
      setCurrentUser(data.user);
      setAuthUsername("");
      setAuthPassword("");
    } catch (err) {
      setAuthError("Could not connect to authentication server.");
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("stackchat_token");
    localStorage.removeItem("stackchat_user");
    setToken(null);
    setCurrentUser(null);
    setConversations([]);
    setActiveConversation(null);
    setMessages({});
  };

  // REST API: Conversations
  const fetchConversations = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setConversations(data);
      }
    } catch (err) {
      console.error("Fetch conversations failed", err);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/chat/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setUsersList(data);
      }
    } catch (err) {
      console.error("Fetch users failed", err);
    }
  };

  // REST API: Fetch Messages for room
  const fetchMessages = async (conversationId) => {
    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations/${conversationId}/messages`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setMessages((prev) => ({ ...prev, [conversationId]: data }));
      }
    } catch (err) {
      console.error("Fetch messages failed", err);
    }
  };

  // REST API: Full-Text search query
  const handleSearchSubmit = async (e) => {
    e?.preventDefault();
    if (!searchQuery.trim()) return;

    try {
      const res = await fetch(`${API_BASE}/api/chat/search/messages?query=${encodeURIComponent(searchQuery)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data);
      }
    } catch (err) {
      console.error("Search query failed", err);
    }
  };

  // REST API: Create direct conversation room
  const startNewDirectChat = async (targetUser) => {
    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          type: "DIRECT",
          participantIds: [targetUser.id]
        })
      });

      if (res.ok) {
        const newRoom = await res.json();
        let fullRoom = newRoom;
        if (newRoom.existing) {
          const found = conversations.find((c) => c.id === newRoom.id);
          if (found) fullRoom = found;
        } else {
          // Add to local state if not exists using latest state reference
          setConversations((prev) => {
            if (prev.some((c) => c.id === newRoom.id)) return prev;
            return [newRoom, ...prev];
          });
        }
        
        // Select the fully populated conversation
        setActiveConversation(fullRoom);
        // Refresh socket connections to join this new room
        if (socketRef.current) {
          socketRef.current.emit("join_room", newRoom.id);
        }

        setActiveModal(null);
      }
    } catch (err) {
      console.error("Start direct chat failed", err);
    }
  };

  const toggleUserForStream = (userId) => {
    setSelectedUsersForStream((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const handleSelectConversation = (conv) => {
    setActiveConversation(conv);
    setMobileSidebarOpen(false);
    
    // Instantly clear unread badge locally for highly responsive feel
    setConversations((prevConvs) =>
      prevConvs.map((c) =>
        c.id === conv.id ? { ...c, last_read_seq: c.max_sequence_id } : c
      )
    );

    // Emit read receipt for maximum sequence
    const maxSeq = Number(conv.max_sequence_id || 0);
    const lastRead = Number(conv.last_read_seq || 0);
    if (socketRef.current && maxSeq > lastRead) {
      socketRef.current.emit("read_receipt", {
        conversationId: conv.id,
        sequenceId: maxSeq
      });
    }
  };

  // REST API: Create stream (group) conversation room
  const startNewStreamChat = async (e) => {
    e.preventDefault();
    if (!newStreamName.trim()) return;

    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          name: newStreamName,
          type: "GROUP",
          participantIds: selectedUsersForStream
        })
      });

      if (res.ok) {
        const newRoom = await res.json();
        setConversations((prev) => {
          if (prev.some((c) => c.id === newRoom.id)) return prev;
          return [newRoom, ...prev];
        });
        
        setActiveConversation(newRoom);
        if (socketRef.current) {
          socketRef.current.emit("join_room", newRoom.id);
        }

        // Reset inputs and close modal
        setNewStreamName("");
        setSelectedUsersForStream([]);
        setActiveModal(null);
      } else {
        const errorData = await res.json();
        alert(errorData.error || "Failed to create stream");
      }
    } catch (err) {
      console.error("Start new stream failed", err);
    }
  };

  // REST API: Admin Stats dashboard
  const openAdminPanel = async () => {
    setActiveModal("admin");
    try {
      const resStats = await fetch(`${API_BASE}/api/admin/stats`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const resUsers = await fetch(`${API_BASE}/api/chat/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (resStats.ok && resUsers.ok) {
        setAdminStats(await resStats.json());
        setAdminUsers(await resUsers.json());
      }
    } catch (err) {
      console.error("Open admin dashboard metrics failed", err);
    }
  };

  // REST API: Delete User (Admin action)
  const deleteUser = async (userId) => {
    if (!confirm("Are you sure you want to permanently delete this user and clear their sockets?")) return;
    try {
      const res = await fetch(`${API_BASE}/api/admin/users/${userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        // Refresh admin views
        setAdminUsers((prev) => prev.filter((u) => u.id !== userId));
        openAdminPanel(); // Refresh metrics
        fetchUsers(); // Refresh general user lists
      } else {
        const errData = await res.json();
        alert(errData.error || "Failed to delete user.");
      }
    } catch (err) {
      console.error("Delete user action failed", err);
    }
  };

  // Client typing indicator with debounce logic
  const handleComposerChange = (e) => {
    setComposerText(e.target.value);

    if (!activeConversation || !socketRef.current) return;

    if (!isTypingRef.current) {
      isTypingRef.current = true;
      socketRef.current.emit("typing:start", activeConversation.id);
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

    typingTimeoutRef.current = setTimeout(() => {
      socketRef.current.emit("typing:stop", activeConversation.id);
      isTypingRef.current = false;
    }, 1500); // 1.5 seconds debounce
  };

  // Messaging Submission
  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!composerText.trim() || !activeConversation || !socketRef.current) return;

    // Build payload structure. Code block wrapping if activated
    const finalBody = isCodeMode ? `\`\`\`javascript\n${composerText}\n\`\`\`` : composerText;

    // Send via socket
    console.log("Client emitting send_message event:", { conversationId: activeConversation.id, body: finalBody });
    socketRef.current.emit(
      "send_message",
      {
        conversationId: activeConversation.id,
        body: finalBody
      },
      (response) => {
        console.log("Client received send_message ack response:", response);
        if (response.error) {
          console.error("Message emit failed:", response.error);
        }
      }
    );

    // Stop typing indicators
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    socketRef.current.emit("typing:stop", activeConversation.id);
    isTypingRef.current = false;

    setComposerText("");
    setIsCodeMode(false);
  };

  // Delete an entire conversation (DMs or Streams)
  const handleDeleteConversation = async (conversationId) => {
    if (!confirm("Are you sure you want to delete this conversation? This will permanently erase all history for all participants.")) return;

    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations/${conversationId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to delete conversation");
        return;
      }
      
      // Update local state
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (activeConversation && activeConversation.id === conversationId) {
        setActiveConversation(null);
      }
    } catch (err) {
      console.error("Delete conversation error:", err);
      alert("Server error deleting conversation");
    }
  };

  // Leave a group stream
  const handleLeaveStream = async (conversationId) => {
    if (!confirm("Are you sure you want to leave this stream?")) return;

    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations/${conversationId}/leave`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to leave stream");
        return;
      }

      // Update local state
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (activeConversation && activeConversation.id === conversationId) {
        setActiveConversation(null);
      }
    } catch (err) {
      console.error("Leave stream error:", err);
      alert("Server error leaving stream");
    }
  };

  // Add developers/users to a stream
  const handleAddUsersToStream = async (conversationId, userIds) => {
    try {
      const res = await fetch(`${API_BASE}/api/chat/conversations/${conversationId}/participants`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ userIds })
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to add users");
        return;
      }
      
      const updatedRoom = await res.json();
      // Update local state
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? updatedRoom : c))
      );
      if (activeConversation && activeConversation.id === conversationId) {
        setActiveConversation(updatedRoom);
      }
    } catch (err) {
      console.error("Add users error:", err);
      alert("Server error adding users");
    }
  };

  // Format timestamp nicely
  const formatTime = (isoString) => {
    if (!isoString) return "";
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  // Helper to parse message text and render code blocks beautifully
  const renderMessageContent = (body) => {
    const codeMatch = body.match(/^```([a-zA-Z0-9-]*)\n([\s\S]*?)\n```$/);
    if (codeMatch) {
      return (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: "11px", fontWeight: "700", opacity: 0.7, fontFamily: "var(--font-code)", marginBottom: "4px" }}>
            CODE SNIPPET
          </span>
          <pre className="code-block">
            <code>{codeMatch[2]}</code>
          </pre>
        </div>
      );
    }
    return <span>{body}</span>;
  };

  // Calculate Checkmarks for delivery status
  const renderMessageStatus = (msg) => {
    if (msg.sender_id !== currentUser.id) return null;

    if (!activeConversation) return null;

    // Find other participants in this active conversation
    const otherParticipants = activeConversation.participants.filter(
      (p) => p.id !== currentUser.id
    );

    if (otherParticipants.length === 0) return null;

    // Check if everyone read it
    const allRead = otherParticipants.every((p) => p.last_read_seq >= msg.sequence_id);
    const allDelivered = otherParticipants.every((p) => p.last_delivered_seq >= msg.sequence_id);

    if (allRead) {
      return (
        <span className="read-ticks read" title="Read by all">
          <CheckCheck size={14} />
        </span>
      );
    } else if (allDelivered) {
      return (
        <span className="read-ticks" title="Delivered to all">
          <CheckCheck size={14} />
        </span>
      );
    }
    return (
      <span className="read-ticks" title="Sent">
        <Check size={14} />
      </span>
    );
  };

  // Return Auth UI if not authenticated
  if (!token || !currentUser) {
    return (
      <div className="auth-wrapper" suppressHydrationWarning>
        <div className="auth-card" suppressHydrationWarning>
          <div className="auth-title" suppressHydrationWarning>StackChat</div>
          <div className="auth-subtitle" suppressHydrationWarning>Production-Grade Real-Time System</div>

          {authError && <div className="error-message">{authError}</div>}

          <form onSubmit={handleAuthSubmit}>
            <div className="form-group" suppressHydrationWarning>
              <label className="form-label">Username</label>
              <input
                type="text"
                className="form-input"
                placeholder="Enter username..."
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
                required
              />
            </div>
            <div className="form-group" suppressHydrationWarning>
              <label className="form-label">Password</label>
              <input
                type="password"
                className="form-input"
                placeholder="Enter password..."
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                required
              />
            </div>
            <button type="submit" className="btn-primary">
              {authMode === "login" ? "Sign In" : "Create Account"}
            </button>
          </form>

          <div className="auth-switch" suppressHydrationWarning>
            {authMode === "login" ? "New to the system?" : "Already registered?"}
            <span
              className="auth-switch-link"
              onClick={() => {
                setAuthMode(authMode === "login" ? "register" : "login");
                setAuthError("");
              }}
            >
              {authMode === "login" ? "Create an account" : "Sign in here"}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Active typing list helper
  const getTypingString = () => {
    if (!activeConversation) return "";
    const convTyping = typingStates[activeConversation.id] || {};
    const typers = Object.values(convTyping);
    if (typers.length === 0) return "";
    if (typers.length === 1) return `${typers[0]} is typing...`;
    return `${typers.slice(0, 2).join(" and ")} are typing...`;
  };

  // Helper to determine direct chat names
  const getRoomName = (conv) => {
    if (conv.type === "DIRECT") {
      const peer = conv.participants.find((p) => p.id !== currentUser.id);
      return peer ? peer.username : "Direct Chat";
    }
    return `# ${conv.name}`;
  };

  const sortedConversations = [...conversations].sort((a, b) => {
    const timeA = new Date(a.updated_at || a.created_at).getTime();
    const timeB = new Date(b.updated_at || b.created_at).getTime();
    return timeB - timeA;
  });

  return (
    <div className={`app-container ${activeConversation ? "has-active-chat" : ""}`} suppressHydrationWarning>
      {/* 1. SIDEBAR */}
      <aside className={`sidebar ${mobileSidebarOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-header">
          <div className="brand">
            <MessageSquare size={20} className="text-primary" />
            <span>StackChat</span>
          </div>
          <div className="sidebar-header-right" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div className="node-badge" title="Active Connection Node">
              {socketConnected ? socketNode : "Offline"}
            </div>
            <button
              className="btn-icon mobile-sidebar-close-btn"
              onClick={() => setMobileSidebarOpen(false)}
              title="Close sidebar"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Channels/Streams */}
        <div className="sidebar-section">
          <div className="section-title" style={{ display: "flex", justifyItems: "center", justifyContent: "space-between", alignItems: "center" }}>
            <span>Streams</span>
            <button
              onClick={() => {
                setSelectedUsersForStream([]);
                setNewStreamName("");
                setActiveModal("new_stream");
              }}
              style={{ background: "none", border: "none", color: "rgba(255, 255, 255, 0.4)", cursor: "pointer" }}
            >
              <Plus size={16} />
            </button>
          </div>
          <ul className="sidebar-list">
            {sortedConversations
              .filter((c) => c.type === "GROUP")
              .map((conv) => (
                <li
                  key={conv.id}
                  className={`sidebar-item ${activeConversation?.id === conv.id ? "active" : ""}`}
                  onClick={() => handleSelectConversation(conv)}
                >
                  <div className="item-left">
                    <span># {conv.name}</span>
                    {Object.keys(typingStates[conv.id] || {}).length > 0 && (
                      <span style={{ fontSize: "11px", color: "rgba(255, 255, 255, 0.5)", marginLeft: "6px", fontStyle: "italic", fontWeight: "normal" }}>typing...</span>
                    )}
                  </div>

                </li>
              ))}
          </ul>
        </div>

        {/* Direct Messages */}
        <div className="sidebar-section" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <div className="section-title" style={{ display: "flex", justifyItems: "center", justifyContent: "space-between", alignItems: "center" }}>
            <span>Direct Messages</span>
            <button
              onClick={() => setActiveModal("new_chat")}
              style={{ background: "none", border: "none", color: "rgba(255, 255, 255, 0.4)", cursor: "pointer" }}
            >
              <Plus size={16} />
            </button>
          </div>
          <ul className="sidebar-list" style={{ overflowY: "auto" }}>
            {sortedConversations
              .filter((c) => c.type === "DIRECT")
              .map((conv) => {
                const peer = conv.participants.find((p) => p.id !== currentUser.id);
                const isOnline = peer && presence[peer.id] === "online";
                return (
                  <li
                    key={conv.id}
                    className={`sidebar-item ${activeConversation?.id === conv.id ? "active" : ""}`}
                    onClick={() => handleSelectConversation(conv)}
                  >
                    <div className="item-left">
                      <span className={`presence-indicator ${isOnline ? "online" : ""}`} />
                      <span>{peer ? peer.username : "User"}</span>
                      {Object.keys(typingStates[conv.id] || {}).length > 0 && (
                        <span style={{ fontSize: "11px", color: "rgba(255, 255, 255, 0.5)", marginLeft: "6px", fontStyle: "italic", fontWeight: "normal" }}>typing...</span>
                      )}
                    </div>

                  </li>
                );
              })}
          </ul>
        </div>

        {/* Sidebar Footer */}
        <footer className="sidebar-footer">
          <div className="user-profile">
            <div className="user-avatar">{currentUser.username.substring(0, 2).toUpperCase()}</div>
            <div className="user-details">
              <span className="user-name">{currentUser.username}</span>
              <span className="user-role">{currentUser.is_admin ? "SysAdmin" : "Developer"}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            {currentUser.is_admin && (
              <button className="btn-icon" onClick={openAdminPanel} title="System Diagnostics">
                <Shield size={16} />
              </button>
            )}
            <button className="btn-icon" onClick={handleLogout} title="Sign Out">
              <Power size={16} />
            </button>
          </div>
        </footer>
      </aside>

      {/* 2. MAIN CHAT AREA */}
      <main className="chat-area">
        {activeConversation ? (
          <>
            {/* Chat Area Header */}
            <header className="chat-header">
              <button
                className="btn-icon mobile-menu-btn"
                onClick={() => setMobileSidebarOpen(true)}
                title="Open channels list"
              >
                <Menu size={18} />
              </button>
              <div className="chat-title-info">
                <span className="chat-title">{getRoomName(activeConversation)}</span>
                <span className="chat-status">
                  {activeConversation.type === "DIRECT" ? "Secure direct line" : `${activeConversation.participants?.length || 0} developers joined`}
                </span>
              </div>
              <div className="chat-actions">
                <button className="btn-icon" style={{ color: "var(--text-muted)" }} onClick={() => setSearchOpen(!searchOpen)}>
                  <Search size={18} />
                </button>
                <button
                  className="btn-icon"
                  style={{ color: "var(--text-muted)" }}
                  onClick={() => setShowDetailPanel(!showDetailPanel)}
                >
                  <Info size={18} />
                </button>
              </div>
            </header>

            {/* In-chat search overlay */}
            {searchOpen && (
              <div className="search-overlay">
                <div className="search-input-wrapper">
                  <input
                    type="text"
                    className="form-input"
                    placeholder="Search history lexemes (GIN powered)..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearchSubmit()}
                  />
                  {searchResults.length > 0 && (
                    <div className="search-results-list">
                      {searchResults.map((res) => (
                        <div
                          key={res.id}
                          className="search-result-item"
                          onClick={() => {
                            // Find matching room and select it
                            const targetConv = conversations.find((c) => c.id === res.conversation_id);
                            if (targetConv) setActiveConversation(targetConv);
                            setSearchOpen(false);
                            setSearchResults([]);
                            setSearchQuery("");
                          }}
                        >
                          <div className="search-result-header">
                            <span>{res.sender_name} in {res.conversation_name || "direct chat"}</span>
                            <span>{new Date(res.created_at).toLocaleDateString()}</span>
                          </div>
                          <div className="search-result-body">{res.body}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <button className="btn-send" onClick={handleSearchSubmit}>
                  Search
                </button>
                <button className="btn-icon" style={{ color: "var(--text-muted)" }} onClick={() => { setSearchOpen(false); setSearchResults([]); setSearchQuery(""); }}>
                  <X size={18} />
                </button>
              </div>
            )}

            {/* Chat Messages Log */}
            <div className="chat-messages">
              {messages[activeConversation.id]?.map((msg, index, arr) => {
                const isMe = msg.sender_id === currentUser.id;
                
                // Show date breaks dynamically
                const msgDate = new Date(msg.created_at).toDateString();
                const prevMsgDate = index > 0 ? new Date(arr[index - 1].created_at).toDateString() : null;
                const showDateBreak = msgDate !== prevMsgDate;

                return (
                  <React.Fragment key={msg.id}>
                    {showDateBreak && (
                      <div className="message-group-date">{msgDate}</div>
                    )}
                    <div className={`message-wrapper ${isMe ? "me" : ""}`}>
                      {!isMe && (
                        <div className="message-avatar">
                          {msg.sender_name?.substring(0, 2).toUpperCase()}
                        </div>
                      )}
                      <div className="message-bubble">
                        <div className="message-info">
                          <span className="message-sender">{msg.sender_name}</span>
                          <span className="message-time">{formatTime(msg.created_at)}</span>
                        </div>
                        <div className="message-text">
                          {renderMessageContent(msg.body)}
                        </div>
                        {isMe && (
                          <div className="message-status">
                            {renderMessageStatus(msg)}
                          </div>
                        )}
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Heartbeat Typing Status relays */}
            {getTypingString() && (
              <div className="typing-status-bar">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span>{getTypingString()}</span>
              </div>
            )}

            {/* Chat Message Composer */}
            <form onSubmit={handleSendMessage} className="message-composer">
              <div className="composer-input-container">
                <textarea
                  className="composer-input"
                  placeholder={isCodeMode ? "Paste or write code here..." : "Type a message..."}
                  rows={isCodeMode ? 4 : 1}
                  value={composerText}
                  onChange={handleComposerChange}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage(e);
                    }
                  }}
                />
                <div className="composer-actions">
                  <div className="composer-tools">
                    <button
                      type="button"
                      className={`btn-composer-tool ${isCodeMode ? "active" : ""}`}
                      onClick={() => setIsCodeMode(!isCodeMode)}
                      title="Wrap as code snippet"
                      style={{ color: isCodeMode ? "var(--primary)" : "var(--text-muted)" }}
                    >
                      <Code size={18} />
                    </button>
                  </div>
                  <button type="submit" className="btn-send">
                    <span>Send</span>
                    <Send size={14} />
                  </button>
                </div>
              </div>
            </form>
          </>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-light)" }}>
            <MessageSquare size={48} style={{ marginBottom: "16px", strokeWidth: 1.5 }} />
            <h3>Select a Conversation to Start</h3>
          </div>
        )}
      </main>

      {/* 3. DETAILS SIDE PANEL (Rightmost panel) */}
      {activeConversation && showDetailPanel && (
        <aside className="detail-panel">
          <header className="panel-header" style={{ display: "flex", justifyItems: "center", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
            <span className="panel-title">Room Details</span>
            <button
              className="btn-icon mobile-detail-close-btn"
              onClick={() => setShowDetailPanel(false)}
              title="Close details"
              style={{ color: "var(--text-muted)" }}
            >
              <X size={18} />
            </button>
          </header>
          <div className="panel-content" style={{ display: "flex", flexDirection: "column", height: "calc(100% - var(--header-height))" }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "24px", overflowY: "auto" }}>
              <div>
                <div className="info-section-title">About</div>
                <div className="info-box">
                  <div className="info-desc">
                    {activeConversation.type === "DIRECT"
                      ? `One-to-One private conversation room.`
                      : `Incident response channel for real-time infrastructure discussion and telemetry updates.`}
                  </div>
                </div>
              </div>

              <div>
                <div className="info-section-title">Participants ({activeConversation.participants?.length || 0})</div>
                <div className="participant-list">
                  {activeConversation.participants?.map((p) => {
                    const isOnline = presence[p.id] === "online";
                    return (
                      <div key={p.id} className="participant-item">
                        <div className="participant-profile">
                          <span className={`presence-indicator ${isOnline ? "online" : ""}`} />
                          <span className="participant-name">{p.username}</span>
                          {p.username === currentUser.username && (
                            <span className="badge-admin-tag" style={{ marginLeft: "4px" }}>You</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {activeConversation.type === "GROUP" && (
                <div>
                  <div className="info-section-title">Add Developers</div>
                  {(() => {
                    const participantIds = new Set(activeConversation.participants?.map((p) => p.id));
                    const addableUsers = usersList.filter((u) => !participantIds.has(u.id));
                    if (addableUsers.length === 0) {
                      return <div className="info-desc" style={{ fontStyle: "italic" }}>All developers joined this stream.</div>;
                    }
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <select
                          className="form-input"
                          style={{ padding: "8px" }}
                          value=""
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val) {
                              handleAddUsersToStream(activeConversation.id, [val]);
                            }
                          }}
                        >
                          <option value="" disabled>Select developer to add...</option>
                          {addableUsers.map((u) => (
                            <option key={u.id} value={u.id}>{u.username}</option>
                          ))}
                        </select>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>

            {/* Danger Zone Actions */}
            <div style={{ marginTop: "auto", paddingTop: "16px", display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--neutral-border)" }}>
              {activeConversation.type === "GROUP" && (
                <button
                  className="btn-danger-outline"
                  style={{ width: "100%", padding: "10px" }}
                  onClick={() => handleLeaveStream(activeConversation.id)}
                >
                  Leave Stream
                </button>
              )}
              {activeConversation.type === "DIRECT" && (
                <button
                  className="btn-danger-outline"
                  style={{ 
                    width: "100%", 
                    padding: "10px", 
                    backgroundColor: "rgba(239, 68, 68, 0.05)",
                    border: "1px solid var(--danger)",
                    color: "var(--danger)"
                  }}
                  onClick={() => handleDeleteConversation(activeConversation.id)}
                >
                  Delete Conversation
                </button>
              )}
            </div>
          </div>
        </aside>
      )}

      {/* 4. DIALOG MODALS */}
      {/* Admin Panel Modal */}
      {activeModal === "admin" && adminStats && (
        <div className="admin-overlay">
          <div className="admin-modal">
            <header className="admin-header">
              <span className="admin-title">
                <Shield size={20} />
                <span>System Dashboard & Cluster Diagnostics</span>
              </span>
              <button className="btn-icon" onClick={() => setActiveModal(null)} style={{ color: "white" }}>
                <X size={20} />
              </button>
            </header>
            <div className="admin-content">
              {/* Stats Counters Grid */}
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-label">Active Node Connections</div>
                  <div className="stat-value" style={{ color: "var(--tertiary)" }}>
                    {adminStats.realtimeStats.activeSockets}
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Total Users</div>
                  <div className="stat-value">{adminStats.dbStats.totalUsers}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Total Rooms</div>
                  <div className="stat-value">{adminStats.dbStats.totalConversations}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">DB Storage Size</div>
                  <div className="stat-value">{adminStats.dbStats.dbSize}</div>
                </div>
              </div>

              {/* Cluster Nodes Status */}
              <div className="admin-section">
                <div className="admin-section-title">
                  <span>Distributed Nodes Cluster Status</span>
                  <Server size={16} />
                </div>
                {adminStats.realtimeStats.serverNodes?.map((node) => (
                  <div key={node.nodeId} className="system-node-row">
                    <span className="system-node-id">{node.nodeId}</span>
                    <span className="system-node-meta">
                      {node.activeSockets} active sockets | Last seen:{" "}
                      {new Date(node.lastActive).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>

              {/* User management list */}
              <div className="admin-section">
                <div className="admin-section-title">
                  <span>Manage Core Accounts</span>
                  <Users size={16} />
                </div>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Username</th>
                      <th>Account Role</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminUsers.map((u) => (
                      <tr key={u.id}>
                        <td style={{ fontWeight: 600 }}>{u.username}</td>
                        <td>{u.is_admin ? "Administrator" : "Developer"}</td>
                        <td>
                          {u.username !== currentUser.username && (
                            <button className="btn-danger-outline" onClick={() => deleteUser(u.id)}>
                              Delete Account
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Start Direct Chat Modal */}
      {activeModal === "new_chat" && (
        <div className="admin-overlay">
          <div className="admin-modal" style={{ maxWidth: "480px", height: "auto" }}>
            <header className="admin-header" style={{ height: "64px" }}>
              <span className="admin-title" style={{ fontSize: "16px" }}>Start Direct Message</span>
              <button className="btn-icon" onClick={() => setActiveModal(null)} style={{ color: "white" }}>
                <X size={18} />
              </button>
            </header>
            <div className="admin-content" style={{ padding: "20px" }}>
              <div className="info-section-title" style={{ marginBottom: "12px" }}>Select a Developer</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "250px", overflowY: "auto" }}>
                {usersList.length > 0 ? (
                  usersList.map((u) => (
                    <div
                      key={u.id}
                      onClick={() => startNewDirectChat(u)}
                      style={{
                        padding: "12px",
                        borderRadius: "8px",
                        backgroundColor: "#f3f4f6",
                        border: "1px solid var(--neutral-border)",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        transition: "all 0.15s ease"
                      }}
                    >
                      <User size={16} />
                      <span style={{ fontWeight: 600 }}>{u.username}</span>
                    </div>
                  ))
                ) : (
                  <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>No other users registered.</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create New Stream Modal */}
      {activeModal === "new_stream" && (
        <div className="admin-overlay">
          <div className="admin-modal" style={{ maxWidth: "480px", height: "auto" }}>
            <header className="admin-header" style={{ height: "64px" }}>
              <span className="admin-title" style={{ fontSize: "16px" }}>Create New Stream</span>
              <button className="btn-icon" onClick={() => setActiveModal(null)} style={{ color: "white" }}>
                <X size={18} />
              </button>
            </header>
            <form onSubmit={startNewStreamChat} className="admin-content" style={{ padding: "20px" }}>
              <div className="form-group" style={{ marginBottom: "16px" }}>
                <label className="form-label" style={{ color: "var(--text-main)", fontWeight: 600 }}>Stream Name</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. general, alerts, dev-chat..."
                  value={newStreamName}
                  onChange={(e) => setNewStreamName(e.target.value)}
                  required
                  style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "1px solid var(--neutral-border)", marginTop: "6px" }}
                />
              </div>

              <div className="info-section-title" style={{ marginBottom: "12px" }}>Invite Participants</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "200px", overflowY: "auto", marginBottom: "20px" }}>
                {usersList.length > 0 ? (
                  usersList.map((u) => {
                    const isSelected = selectedUsersForStream.includes(u.id);
                    return (
                      <div
                        key={u.id}
                        onClick={() => toggleUserForStream(u.id)}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "8px",
                          backgroundColor: isSelected ? "rgba(79, 70, 229, 0.08)" : "#f3f4f6",
                          border: isSelected ? "1px solid var(--primary)" : "1px solid var(--neutral-border)",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          transition: "all 0.15s ease"
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <User size={16} style={{ color: isSelected ? "var(--primary)" : "inherit" }} />
                          <span style={{ fontWeight: 600, color: isSelected ? "var(--primary)" : "inherit" }}>{u.username}</span>
                        </div>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}} // handled by click
                          style={{ pointerEvents: "none" }}
                        />
                      </div>
                    );
                  })
                ) : (
                  <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>No other users registered.</span>
                )}
              </div>

              <button type="submit" className="btn-primary" style={{ width: "100%", padding: "12px", borderRadius: "8px", fontWeight: "600" }}>
                Create Stream
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
