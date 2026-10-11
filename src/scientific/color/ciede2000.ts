import type { Lab } from '../types';
export function deltaE00(a:Lab,b:Lab):number {
 const [L1,a1,b1]=a,[L2,a2,b2]=b,rad=Math.PI/180; const C1=Math.hypot(a1,b1),C2=Math.hypot(a2,b2),Cb=(C1+C2)/2;
 const G=.5*(1-Math.sqrt(Math.pow(Cb,7)/(Math.pow(Cb,7)+Math.pow(25,7)))); const ap1=(1+G)*a1,ap2=(1+G)*a2;
 const C1p=Math.hypot(ap1,b1),C2p=Math.hypot(ap2,b2); const hp=(a:number,b:number)=>{let h=Math.atan2(b,a)/rad;return h<0?h+360:h}; const h1=hp(ap1,b1),h2=hp(ap2,b2);
 const dLp=L2-L1,dCp=C2p-C1p; let dh=h2-h1;if(C1p*C2p===0)dh=0;else if(dh>180)dh-=360;else if(dh<-180)dh+=360; const dHp=2*Math.sqrt(C1p*C2p)*Math.sin(dh*rad/2);
 const Lp=(L1+L2)/2,Cp=(C1p+C2p)/2; let hpbar=h1+h2;if(C1p*C2p===0)hpbar=h1+h2;else if(Math.abs(h1-h2)<=180)hpbar=(h1+h2)/2;else hpbar=(h1+h2+360)/2;if(hpbar>=360)hpbar-=360;
 const T=1-.17*Math.cos((hpbar-30)*rad)+.24*Math.cos(2*hpbar*rad)+.32*Math.cos((3*hpbar+6)*rad)-.20*Math.cos((4*hpbar-63)*rad);
 const dtheta=30*Math.exp(-Math.pow((hpbar-275)/25,2)),Rc=2*Math.sqrt(Math.pow(Cp,7)/(Math.pow(Cp,7)+Math.pow(25,7)));
 const Sl=1+.015*Math.pow(Lp-50,2)/Math.sqrt(20+Math.pow(Lp-50,2)),Sc=1+.045*Cp,Sh=1+.015*Cp*T,Rt=-Math.sin(2*dtheta*rad)*Rc;
 return Math.sqrt(Math.pow(dLp/Sl,2)+Math.pow(dCp/Sc,2)+Math.pow(dHp/Sh,2)+Rt*(dCp/Sc)*(dHp/Sh));
}
