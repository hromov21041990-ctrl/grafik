/* Monthly payroll model for v2 beta. No persistence or browser globals.
 * Dates are ISO YYYY-MM-DD. Monetary values use integer kopecks internally.
 * Monthly fines are separate from weekly fines to avoid double counting.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.PoGrafikuMonthlyPayroll=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function cents(value){
    const n=Number(value);
    if(!Number.isFinite(n)||Math.abs(n)>100000000||Math.abs(n*100-Math.round(n*100))>0.00001)
      throw new Error('Некорректная сумма');
    return Math.round(n*100);
  }
  function money(value){return value/100;}
  function validMonth(month){return typeof month==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(month);}
  function calculate({month,employee,schedule=[],adjustment=0,advance=null,finalPayment=null}){
    if(!validMonth(month))throw new Error('Неверный месяц');
    if(typeof employee!=='string'||!employee)throw new Error('Не указан сотрудник');
    const selected=schedule.filter(entry=>entry.employee===employee&&
      typeof entry.date==='string'&&entry.date.slice(0,7)===month);
    const accrued=selected.reduce((sum,entry)=>sum+cents(entry.pay||0),0);
    const correction=cents(adjustment);
    const advanceAmount=advance&&advance.paid?cents(advance.amount):0;
    const due=accrued-correction-advanceAmount;
    const finalPaid=finalPayment&&finalPayment.paid?cents(finalPayment.amount):0;
    return {month,employee,shifts:selected.length,accrued:money(accrued),
      adjustment:money(correction),advancePaid:money(advanceAmount),
      finalPaid:money(finalPaid),due:money(due),outstanding:money(due-finalPaid),
      advanceStatus:advance?.paid?'paid':'unpaid',
      finalStatus:finalPayment?.paid?'paid':'unpaid'};
  }
  function validateAdvance(amount){const n=cents(amount);if(n<0)throw new Error('Аванс не может быть отрицательным');return money(n);}
  function paymentKey(month,employee){if(!validMonth(month)||!employee)throw new Error('Неверный ключ выплаты');return 'month:'+month+'|'+employee;}
  return {calculate,validateAdvance,paymentKey};
});
