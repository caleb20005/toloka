(function () {
  const KES_PER_USD = 130;
  const token = localStorage.getItem('token');
  const userId = localStorage.getItem('userId');
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const money = (value) => {
    // Account values are persisted in KES for M-PESA reconciliation. Format
    // them here directly so Wallet cannot accidentally prefix a KES value
    // with a dollar sign if another display script fails to initialise.
    const kes = Number(value || 0);
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(kes / KES_PER_USD);
  };
  const request = async (path) => {
    const response = await fetch(path, { headers });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
  };
  const rows = (value) => Array.isArray(value) ? value : (value?.rows || value?.data || []);
  const status = document.getElementById('walletStatus');

  function activityRow(type, item, amount) {
    const date = item.submitted_at || item.created_at || item.transaction_time || item.createdAt;
    const when = date ? new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recent';
    const state = String(item.status || 'pending').toLowerCase();
    return `<div class="wallet-activity-row"><div><b>${type}</b><small>${when}</small></div><strong>${money(amount)}</strong><span class="wallet-badge ${state}">${state}</span></div>`;
  }

  async function loadWallet() {
    if (!token || !userId) {
      window.location.replace('login.html?returnTo=wallet.html');
      return;
    }
    try {
      const [profileResult, withdrawalsResult, loansResult, savingsResult, savingsWithdrawalsResult] = await Promise.allSettled([
        request(`/api/user/${userId}`), request(`/api/user/${userId}/withdrawals`), request(`/api/user/${userId}/loans`), request(`/api/user/${userId}/savings-history`), request(`/api/user/${userId}/savings-withdrawals`)
      ]);
      const profile = profileResult.status === 'fulfilled' ? (profileResult.value.user || profileResult.value) : {};
      const withdrawals = withdrawalsResult.status === 'fulfilled' ? rows(withdrawalsResult.value) : [];
      const loans = loansResult.status === 'fulfilled' ? rows(loansResult.value) : [];
      const savings = savingsResult.status === 'fulfilled' ? rows(savingsResult.value) : [];
      const savingsWithdrawals = savingsWithdrawalsResult.status === 'fulfilled' ? rows(savingsWithdrawalsResult.value) : [];
      const earned = Number(profile.totalEarned ?? localStorage.getItem('totalEarned') ?? 0);
      const available = Number(profile.expectedEarning ?? profile.availableEarnings ?? localStorage.getItem('expectedEarning') ?? 0);
      const saved = Number(profile.savingsBalance ?? localStorage.getItem('savingsBalance') ?? savings.reduce((total, item) => total + Number(item.total_balance ?? item.amount ?? 0), 0));
      const open = [...withdrawals, ...loans, ...savingsWithdrawals].filter((item) => !['completed', 'approved', 'rejected'].includes(String(item.status || '').toLowerCase())).length;
      document.getElementById('availableEarnings').textContent = money(available);
      document.getElementById('lifetimeEarnings').textContent = money(earned);
      document.getElementById('savingsBalance').textContent = money(saved);
      document.getElementById('openRequests').textContent = String(open);
      status.textContent = 'Balances updated from your account.';
      const activity = [
        ...withdrawals.map((item) => ({ type: 'Earnings withdrawal', item, amount: item.amount })),
        ...savingsWithdrawals.map((item) => ({ type: 'Savings withdrawal', item, amount: item.amount })),
        ...loans.map((item) => ({ type: 'Loan application', item, amount: item.amount || 0 }))
      ].sort((a, b) => new Date(b.item.submitted_at || b.item.created_at || 0) - new Date(a.item.submitted_at || a.item.created_at || 0)).slice(0, 5);
      document.getElementById('walletActivity').innerHTML = activity.length ? activity.map((entry) => activityRow(entry.type, entry.item, entry.amount)).join('') : '<p class="wallet-empty">No payout, savings, or loan requests yet.</p>';
    } catch (error) {
      status.textContent = 'We could not refresh every balance. Your existing account data is still available.';
      document.getElementById('walletActivity').innerHTML = '<p class="wallet-empty">Activity is temporarily unavailable. Open History to review your records.</p>';
    }
  }
  loadWallet();
})();
