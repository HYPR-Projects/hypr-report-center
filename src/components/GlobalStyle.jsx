import { C } from "../shared/theme";

const GlobalStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Urbanist:wght@300;400;500;600;700;800;900&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    html,body,#root{width:100%;min-height:100vh;}
    body{font-family:'Urbanist',sans-serif;background:${C.dark};color:${C.white};min-height:100vh;}
    ::-webkit-scrollbar{width:6px;} ::-webkit-scrollbar-track{background:${C.dark2};}
    ::-webkit-scrollbar-thumb{background:${C.blueDark};border-radius:3px;}
    input,button,select{font-family:'Urbanist',sans-serif;}
    button:focus,button:focus-visible{outline:none!important;box-shadow:none!important;}
    input:focus,input:focus-visible{outline:none!important;}
    @keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes particleFloat{
      0%,100%{transform:translateY(0) translateX(0) scale(1);opacity:0.6;}
      25%{transform:translateY(-20px) translateX(12px) scale(1.15);opacity:0.9;}
      75%{transform:translateY(14px) translateX(-10px) scale(0.9);opacity:0.7;}
    }
    .fade-in{animation:fadeIn 0.35s ease forwards;}
    @media(max-width:640px){
      .resp-hide{display:none!important;}
      .camp-row{flex-direction:column!important;align-items:flex-start!important;}
      .camp-actions{width:100%;}
      .camp-actions button{flex:1;}
    }
    table{border-collapse:collapse;width:100%;}
    th,td{padding:10px 14px;text-align:left;white-space:nowrap;}
    thead tr{background:${C.dark3};}
    tbody tr{border-bottom:1px solid ${C.dark3};}
    tbody tr:hover{background:${C.dark3}40;}
  `}</style>
);

export default GlobalStyle;
