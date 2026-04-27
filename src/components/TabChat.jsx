import { useState, useEffect, useRef } from "react";
import { C } from "../shared/theme";
import { getComments, saveComment } from "../lib/api";

const POLL_INTERVAL_MS = 30000;

const TabChat = ({ token, tabName, author, adminJwt, theme }) => {
  const [messages, setMessages] = useState([]);
  const [newMsg, setNewMsg] = useState("");
  const [sending, setSending] = useState(false);
  const containerRef = useRef(null);
  const shouldScroll = useRef(false);

  useEffect(()=>{
    const controller = new AbortController();
    let active = true;

    const loadMessages = () => {
      getComments(token, { signal: controller.signal })
        .then(all => {
          if(!active) return;
          setMessages(all.filter(c => c.metric_name === tabName));
        })
        .catch(err => {
          if (err?.name === "AbortError") return;
        });
    };

    loadMessages();
    const interval = setInterval(loadMessages, POLL_INTERVAL_MS);
    return () => {
      active = false;
      controller.abort();
      clearInterval(interval);
    };
  },[token, tabName]);

  useEffect(()=>{
    if(shouldScroll.current && containerRef.current){
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      shouldScroll.current = false;
    }
  },[messages]);

  const sendMessage = async() => {
    if(!newMsg.trim()) return;
    setSending(true);
    try{
      await saveComment({
        short_token: token,
        metric_name: tabName,
        author,
        comment: newMsg.trim(),
        adminJwt,
      });
      setMessages(prev=>[...prev,{metric_name:tabName, author, comment:newMsg.trim(), created_at:new Date().toISOString()}]);
      shouldScroll.current = true;
      setNewMsg("");
    }catch(e){}
    finally{setSending(false);}
  };

  const tc_bg  = theme?.bg  || C.dark;
  const tc_bg2 = theme?.bg2 || C.dark2;
  const tc_bg3 = theme?.bg3 || C.dark3;
  const tc_bdr = theme?.bdr || C.dark3;
  const tc_txt = theme?.text|| C.white;
  const tc_mut = theme?.muted||C.muted;
  return(
    <div style={{marginTop:32,border:`1px solid ${tc_bdr}`,borderRadius:12,overflow:"hidden"}}>
      <div style={{background:tc_bg2,padding:"12px 16px",borderBottom:`1px solid ${tc_bdr}`,display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontSize:14}}>💬</span>
        <span style={{fontSize:13,fontWeight:600,color:tc_txt}}>Conversa</span>
        {messages.length>0&&<span style={{fontSize:11,color:tc_mut}}>· {messages.length} mensagem{messages.length>1?"s":""}</span>}
      </div>
      <div ref={containerRef} style={{background:tc_bg,padding:16,maxHeight:300,overflowY:"auto",display:"flex",flexDirection:"column",gap:10}}>
        {messages.length===0&&(
          <div style={{textAlign:"center",color:tc_mut,fontSize:13,padding:"20px 0"}}>Nenhuma mensagem ainda. Seja o primeiro a comentar!</div>
        )}
        {messages.map((m,i)=>{
          const isHypr = m.author==="HYPR";
          return(
            <div key={i} style={{display:"flex",flexDirection:"column",alignItems:isHypr?"flex-end":"flex-start"}}>
              <div style={{fontSize:10,color:tc_mut,marginBottom:3,fontWeight:600,letterSpacing:0.5}}>
                {isHypr?"HYPR":"Cliente"}
              </div>
              <div style={{
                background:isHypr?C.blue:"#FFFFFF",
                border:`1px solid ${isHypr?C.blue:"#DDDDDD"}`,
                borderRadius:isHypr?"12px 12px 2px 12px":"12px 12px 12px 2px",
                padding:"8px 12px",
                maxWidth:"75%",
              }}>
                <div style={{fontSize:13,color:isHypr?C.white:"#1C262F"}}>{m.comment}</div>
              </div>
              <div style={{fontSize:10,color:tc_mut,marginTop:3}}>{m.created_at?.slice(0,16).replace("T"," ")}</div>
            </div>
          );
        })}
        <div/>
      </div>
      <div style={{background:tc_bg2,padding:"10px 12px",borderTop:`1px solid ${tc_bdr}`,display:"flex",gap:8}}>
        <input value={newMsg} onChange={e=>setNewMsg(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&sendMessage()}
          placeholder="Digite uma mensagem..."
          style={{flex:1,background:tc_bg3,border:`1px solid ${tc_bdr}`,borderRadius:8,padding:"8px 12px",color:tc_txt,fontSize:13,outline:"none"}}/>
        <button onClick={sendMessage} disabled={sending||!newMsg.trim()}
          style={{background:C.blue,color:C.white,border:"none",borderRadius:8,padding:"8px 16px",cursor:"pointer",fontSize:13,fontWeight:600,opacity:!newMsg.trim()?0.5:1}}>
          {sending?"...":"↑"}
        </button>
      </div>
    </div>
  );
};

export default TabChat;
