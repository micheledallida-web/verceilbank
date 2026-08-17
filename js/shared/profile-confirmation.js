// Shared confirmation-screen builder used by every Profile "destination"
// detail page (Full Legal Name, Date of Birth, Residential Address, etc).
// Keeps the "Profile Updated Successfully" screen visually and behaviourally
// consistent across all of them.

export function showConfirmation(root, ctx, { fieldLabel, valueText }) {
  const formView = root.querySelector('#pdFormView');
  const confirmView = root.querySelector('#pdConfirmView');
  if (!confirmView) return;

  const refNumber = ctx.genRef();
  const dateStr = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  // This screen is shared by every Profile field, so the address treatment has
  // to be opt-in: tagging the New Value row unconditionally would take the
  // hairline off the Name, Date of Birth, Phone and Email confirmations too.
  const isAddress = /address/i.test(fieldLabel);

  confirmView.innerHTML = `
    <div class="flex flex-col items-center text-center pt-[32px] pb-[8px]">
      <span class="w-[72px] h-[72px] rounded-full bg-green-50 flex items-center justify-center mb-[20px]">
        <svg class="w-[36px] h-[36px] text-[#16A34A]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path></svg>
      </span>
      <div class="text-[22px] font-bold text-[#0F172A] dark:text-white mb-[8px]">Profile Updated Successfully</div>
      <div class="text-[15px] text-[#6B7280] dark:text-[#8E9CBA] mb-[28px]">Your ${fieldLabel.toLowerCase()} has been updated.</div>
    </div>
    <div class="bg-white dark:bg-[#0D1728] rounded-[20px] border border-[#E5E7EB] dark:border-white/[0.06] shadow-sm overflow-hidden mb-[28px]">
      <div class="flex items-center justify-between px-[18px] min-h-[60px] border-b border-[#E5E7EB]">
        <span class="text-[14px] text-[#6B7280] dark:text-[#8E9CBA]">Updated Field</span>
        <span class="text-[15px] font-semibold text-[#0F172A] dark:text-white text-right">${fieldLabel}</span>
      </div>
      <div${isAddress ? ' data-profile-address' : ''} class="flex items-center justify-between px-[18px] min-h-[60px] border-b border-[#E5E7EB]">
        <span class="text-[14px] text-[#6B7280] dark:text-[#8E9CBA]">New Value</span>
        <span class="text-[15px] font-semibold text-[#0F172A] dark:text-white text-right truncate max-w-[220px]">${valueText}</span>
      </div>
      <div class="flex items-center justify-between px-[18px] min-h-[60px] border-b border-[#E5E7EB]">
        <span class="text-[14px] text-[#6B7280] dark:text-[#8E9CBA]">Date &amp; Time</span>
        <span class="text-[15px] font-semibold text-[#0F172A] dark:text-white text-right">${dateStr}</span>
      </div>
      <div class="flex items-center justify-between px-[18px] min-h-[60px]">
        <span class="text-[14px] text-[#6B7280] dark:text-[#8E9CBA]">Confirmation Number</span>
        <span class="text-[15px] font-semibold text-[#0F172A] dark:text-white text-right">${refNumber}</span>
      </div>
    </div>
    <div class="flex flex-col gap-[12px]">
      <button id="pdDoneBtn" type="button" class="w-full h-[56px] rounded-[16px] bg-[#2563EB] text-white text-[16px] font-semibold cursor-pointer">Done</button>
      <button id="pdReturnBtn" type="button" class="w-full h-[56px] rounded-[16px] bg-white dark:bg-[#0D1728] border border-[#E5E7EB] dark:border-white/10 text-[#2563EB] text-[16px] font-semibold cursor-pointer">Return to Profile</button>
    </div>
  `;

  if (formView) formView.classList.add('hidden');
  confirmView.classList.remove('hidden');

  confirmView.querySelector('#pdDoneBtn').addEventListener('click', () => ctx.close());
  confirmView.querySelector('#pdReturnBtn').addEventListener('click', () => ctx.loadPage('profile'));
}
