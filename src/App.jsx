import React, { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BrowserProvider, Contract, formatEther, parseEther } from "ethers";
import Web3Modal from "web3modal";
import WalletConnectProvider from "@walletconnect/web3-provider";
import logo from "./assets/tubbly-logo.svg";

/**
 * 🎰 BlockInstantLottery — Casino-style dApp UI (Sepolia)
 * - Connect wallet (MetaMask)
 * - Show current params (prize, fee, chance, contract balance)
 * - Play (1 try / address / block) with userSalt
 * - See immediate result (win/lose) + confetti on win
 * - Claim pending prizes
 * - Fund contract
 * - Owner panel: setParams
 *
 * Notes:
 * - Chain: Sepolia (11155111)
 * - Randomness is not secure (prevrandao); for small prizes only.
 */

const CONTRACT_ADDRESS = "0x1e6492d25C4890Ccc49389fc50385e6FA25c5477"; // your deployed address (Sepolia)

// Minimal ABI for the functions/events we use
const ABI = [
  // --- Read ---
  { "type": "function", "name": "prizeWei", "stateMutability": "view", "inputs": [], "outputs": [{ "type": "uint256" }] },
  { "type": "function", "name": "entryFeeWei", "stateMutability": "view", "inputs": [], "outputs": [{ "type": "uint256" }] },
  { "type": "function", "name": "winChancePpm", "stateMutability": "view", "inputs": [], "outputs": [{ "type": "uint32" }] },
  { "type": "function", "name": "owner", "stateMutability": "view", "inputs": [], "outputs": [{ "type": "address" }] },
  { "type": "function", "name": "contractBalance", "stateMutability": "view", "inputs": [], "outputs": [{ "type": "uint256" }] },
  { "type": "function", "name": "lastPlayedBlock", "stateMutability": "view", "inputs": [{ "name": "player", "type": "address" }], "outputs": [{ "type": "uint256" }] },
  { "type": "function", "name": "pendingPrizes", "stateMutability": "view", "inputs": [{ "name": "player", "type": "address" }], "outputs": [{ "type": "uint256" }] },
  { "type": "function", "name": "canPlayNow", "stateMutability": "view", "inputs": [{ "name": "player", "type": "address" }], "outputs": [{ "type": "bool" }] },
  { "type": "function", "name": "nextAllowedBlock", "stateMutability": "view", "inputs": [{ "name": "player", "type": "address" }], "outputs": [{ "type": "uint256" }] },

  // --- Write ---
  { "type": "function", "name": "play", "stateMutability": "payable", "inputs": [{ "name": "userSalt", "type": "uint256" }], "outputs": [{ "type": "bool" }] },
  { "type": "function", "name": "claim", "stateMutability": "nonpayable", "inputs": [], "outputs": [] },
  { "type": "function", "name": "fund", "stateMutability": "payable", "inputs": [], "outputs": [] },
  { "type": "function", "name": "ownerWithdraw", "stateMutability": "nonpayable", "inputs": [{ "name": "amount", "type": "uint256" }], "outputs": [] },
  { "type": "function", "name": "setParams", "stateMutability": "nonpayable", "inputs": [
      { "name": "_prizeWei", "type": "uint256" },
      { "name": "_feeWei", "type": "uint256" },
      { "name": "_winChancePpm", "type": "uint32" }
  ], "outputs": [] },

  // --- Events we decode ---
  { "type": "event", "name": "Result", "inputs": [
      { "name": "player", "type": "address", "indexed": true },
      { "name": "won", "type": "bool", "indexed": false },
      { "name": "prizeAmount", "type": "uint256", "indexed": false }
  ] },
  { "type": "event", "name": "PrizePaid", "inputs": [
      { "name": "to", "type": "address", "indexed": true },
      { "name": "amount", "type": "uint256", "indexed": false }
  ] },
  { "type": "event", "name": "PrizePending", "inputs": [
      { "name": "to", "type": "address", "indexed": true },
      { "name": "amount", "type": "uint256", "indexed": false }
  ] },
  { "type": "event", "name": "ParamsUpdated", "inputs": [
      { "name": "prizeWei", "type": "uint256", "indexed": false },
      { "name": "entryFeeWei", "type": "uint256", "indexed": false },
      { "name": "winChancePpm", "type": "uint32", "indexed": false }
  ] },
];

const PPM_DEN = 1_000_000;
const SEPOLIA_CHAIN_ID = 11155111;

const providerOptions = {
  walletconnect: {
    package: WalletConnectProvider,
    options: {
      rpc: {
        [SEPOLIA_CHAIN_ID]: "https://ethereum-sepolia.publicnode.com",
      },
    },
  },
};

const web3Modal = new Web3Modal({
  cacheProvider: false,
  providerOptions,
});

function pctFromPpm(ppm) {
  return Number(ppm) / 10_000; // 10000 ppm = 1%
}

function ppmFromPct(pct) {
  return Math.round(parseFloat(String(pct)) * 10_000);
}

export default function App() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState("");
  const [networkOk, setNetworkOk] = useState(false);
  const [contract, setContract] = useState(null);

  // Contract state
  const [prizeWei, setPrizeWei] = useState(0n);
  const [feeWei, setFeeWei] = useState(0n);
  const [chancePpm, setChancePpm] = useState(0);
  const [contractBal, setContractBal] = useState(0n);
  const [pendingMine, setPendingMine] = useState(0n);
  const [lastPlayedBlock, setLastPlayedBlock] = useState(0n);
  const [currentBlock, setCurrentBlock] = useState(0n);

  // UI state
  const [salt, setSalt] = useState(String(Math.floor(Math.random() * 1e12)));
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [wonState, setWonState] = useState(null);
  const [progressMessage, setProgressMessage] = useState("Drawing in progress...");
  const [rejected, setRejected] = useState(false);
  const [logLines, setLogLines] = useState([]);

  const addLog = (entry) => setLogLines((l) => [entry, ...l].slice(0, 50));
  const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  const shortHash = (h) => (h ? `${h.slice(0, 10)}…` : "");

  const canPlay = useMemo(() => {
    if (!account) return false;
    if (lastPlayedBlock === 0n) return true;
    return lastPlayedBlock < currentBlock;
  }, [account, lastPlayedBlock, currentBlock]);

  async function connect() {
    try {
      const instance = await web3Modal.connect();
      const prov = new BrowserProvider(instance);
      const net = await prov.getNetwork();
      setNetworkOk(Number(net.chainId) === SEPOLIA_CHAIN_ID);
      if (Number(net.chainId) !== SEPOLIA_CHAIN_ID) {
        try {
          await instance.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0xaa36a7" }], // 11155111
          });
        } catch {}
      }

      const accounts = await prov.send("eth_requestAccounts", []);
      const s = await prov.getSigner();

      setProvider(prov);
      setSigner(s);
      setAccount(accounts[0]);

      const c = new Contract(CONTRACT_ADDRESS, ABI, s);
      setContract(c);
    } catch (e) {
      setStatus(e?.shortMessage || e?.message || "Connection failed");
    }
  }

  async function disconnect() {
    try {
      await web3Modal.clearCachedProvider();
      await provider?.provider?.disconnect?.();
    } catch {}
    setProvider(null);
    setSigner(null);
    setAccount("");
    setContract(null);
    setNetworkOk(false);
  }

  useEffect(() => {
    if (!contract || !provider || !account) return;
    let mounted = true;

    async function loadAll() {
      try {
        const [p, f, w, bal, pend, last, blk] = await Promise.all([
          contract.prizeWei(),
          contract.entryFeeWei(),
          contract.winChancePpm(),
          contract.contractBalance(),
          contract.pendingPrizes(account),
          contract.lastPlayedBlock(account),
          provider.getBlockNumber(),
        ]);
        if (!mounted) return;
        setPrizeWei(p);
        setFeeWei(f);
        setChancePpm(Number(w));
        setContractBal(bal);
        setPendingMine(pend);
        setLastPlayedBlock(last);
        setCurrentBlock(BigInt(blk));
      } catch (e) {}
    }

    loadAll();
    const iv = setInterval(loadAll, 5000);
    return () => {
      mounted = false;
      clearInterval(iv);
    };
  }, [contract, provider, account]);

  async function doPlay() {
    if (!contract || !signer) return;
    try {
      setLoading(true);
      setWonState(null);
      setStatus("");
      setProgressMessage("Drawing in progress...");
      setRejected(false);

      const saltVal = BigInt(salt || "0");
      const overrides = { value: feeWei };
      const tx = await contract.play(saltVal, overrides);
      addLog({ text: `play(tx: ${shortHash(tx.hash)})`, txHash: tx.hash });
      const rcpt = await tx.wait();

      let won = null;
      let prize = 0n;
      for (const log of rcpt.logs) {
        try {
          const parsed = contract.interface.parseLog(log);
          if (parsed?.name === "Result") {
            won = parsed.args.won;
            prize = parsed.args.prizeAmount;
            addLog({
              text: parsed.args.won
                ? `Result → WIN ${formatEther(parsed.args.prizeAmount)} ETH`
                : "Result → Loss",
              txHash: rcpt.transactionHash,
            });
          }
          if (parsed?.name === "PrizePaid") {
            addLog({
              text: `PrizePaid → ${formatEther(parsed.args.amount)} ETH`,
              txHash: rcpt.transactionHash,
            });
          }
          if (parsed?.name === "PrizePending") {
            addLog({
              text: `PrizePending → ${formatEther(parsed.args.amount)} ETH`,
              txHash: rcpt.transactionHash,
            });
          }
        } catch {}
      }

      if (won === true) {
        setWonState(true);
        setStatus("");
      } else if (won === false) {
        setWonState(false);
        setStatus("");
      } else {
        setStatus("Finished. (No Result event decoded)");
      }
    } catch (e) {
      if (
        e?.code === "ACTION_REJECTED" ||
        /user rejected/i.test(e?.shortMessage || e?.message || "")
      ) {
        setRejected(true);
        setStatus("");
      } else {
        setStatus(e?.shortMessage || e?.message || "Tx failed");
      }
      addLog({ text: `Error: ${e?.shortMessage || e?.message}` });
    } finally {
      setLoading(false);
    }
  }

  async function doClaim() {
    if (!contract) return;
    try {
      setLoading(true);
      setRejected(false);
      const tx = await contract.claim();
      addLog({ text: `claim(tx: ${shortHash(tx.hash)})`, txHash: tx.hash });
      await tx.wait();
      setStatus("Claimed (if any pending)");
    } catch (e) {
      if (
        e?.code === "ACTION_REJECTED" ||
        /user rejected/i.test(e?.shortMessage || e?.message || "")
      ) {
        setRejected(true);
        setStatus("");
      } else {
        setStatus(e?.shortMessage || e?.message || "Claim failed");
      }
      addLog({ text: `Error: ${e?.shortMessage || e?.message}` });
    } finally {
      setLoading(false);
    }
  }

  async function doFund(amountEth) {
    if (!contract || !signer) return;
    try {
      setLoading(true);
      setWonState(null);
      setStatus("");
      setProgressMessage("Funding in action...");
      setRejected(false);
      const tx = await contract.fund({ value: parseEther(amountEth || "0") });
      addLog({
        text: `fund ${amountEth} ETH (tx: ${shortHash(tx.hash)})`,
        txHash: tx.hash,
      });
      await tx.wait();
      setStatus("Funded ✔");
    } catch (e) {
      if (
        e?.code === "ACTION_REJECTED" ||
        /user rejected/i.test(e?.shortMessage || e?.message || "")
      ) {
        setRejected(true);
        setStatus("");
      } else {
        setStatus(e?.shortMessage || e?.message || "Fund failed");
      }
      addLog({ text: `Error: ${e?.shortMessage || e?.message}` });
    } finally {
      setLoading(false);
    }
  }

  const [fundAmt, setFundAmt] = useState("");

  // Owner panel
  const [isOwner, setIsOwner] = useState(false);
  const [pPrize, setPPrize] = useState("0.0001");
  const [pFee, setPFee] = useState("0");
  const [pPct, setPPct] = useState("1");

  useEffect(() => {
    (async () => {
      if (!contract || !account) return;
      try {
        const own = await contract.owner();
        setIsOwner(own?.toLowerCase?.() === account?.toLowerCase?.());
      } catch {}
    })();
  }, [contract, account]);

  async function applyParams() {
    if (!contract) return;
    try {
      setLoading(true);
      setRejected(false);
      const prize = parseEther(pPrize || "0");
      const fee = parseEther(pFee || "0");
      const ppm = ppmFromPct(pPct || "0");
      const tx = await contract.setParams(prize, fee, ppm);
      addLog({
        text: `setParams → prize ${pPrize} ETH, fee ${pFee} ETH, chance ${pPct}%`,
        txHash: tx.hash,
      });
      await tx.wait();
      setStatus("Parameters updated");
    } catch (e) {
      if (
        e?.code === "ACTION_REJECTED" ||
        /user rejected/i.test(e?.shortMessage || e?.message || "")
      ) {
        setRejected(true);
        setStatus("");
      } else {
        setStatus(e?.shortMessage || e?.message || "setParams failed");
      }
      addLog({ text: `Error: ${e?.shortMessage || e?.message}` });
    } finally {
      setLoading(false);
    }
  }

  const Label = ({ children }) => (
    <span className="text-xs uppercase tracking-wider text-zinc-400">{children}</span>
  );

  const LostMessage = () => (
    <motion.div
      key="lose"
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ opacity: 0 }}
      className="w-full text-center px-4 py-2 rounded-xl bg-rose-600/20 border border-rose-500/40 text-rose-300"
    >
      You lost. Better luck next time!
    </motion.div>
  );

  const StatusMessage = ({ children, k = "status" }) => (
    <motion.div
      key={k}
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ opacity: 0 }}
      className="w-full text-center px-4 py-2 rounded-xl bg-amber-600/20 border border-amber-500/40 text-amber-300"
    >
      {children}
    </motion.div>
  );

  const RejectedMessage = () => (
    <StatusMessage k="rejected">User rejected action.</StatusMessage>
  );

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-black via-zinc-900 to-black text-zinc-100">
      {/* Top bar */}
      <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src={logo} alt="Tubbly logo" className="h-8 w-auto" />
          <div className="font-semibold text-xl">Lucky Block — Instant Lottery (Sepolia)</div>
          <span className="text-xs ml-2 rounded-full bg-emerald-700/30 px-2 py-0.5 border border-emerald-600/40">Testnet</span>
        </div>
        <div className="flex items-center gap-3">
          {account ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-300">{shortAddr(account)}</span>
              <button
                className="px-3 py-1 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-zinc-700 text-sm"
                onClick={() => navigator.clipboard.writeText(account)}
              >Copy</button>
              <button
                className="px-3 py-1 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-zinc-700 text-sm"
                onClick={disconnect}
              >Disconnect</button>
            </div>
          ) : (
            <button
              onClick={connect}
              className="px-4 py-2 rounded-2xl bg-amber-500 hover:bg-amber-400 text-black font-semibold shadow"
            >Connect Wallet</button>
          )}
        </div>
      </div>

      {/* Hero panel */}
      <div className="mx-auto max-w-6xl px-4 grid md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-3xl font-extrabold tracking-tight">Spin the Wheel</div>
                <div className="text-zinc-400">1 try per address per block • Fair-ish on testnet</div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold">{formatEther(prizeWei || 0n)} ETH</div>
                <div className="text-zinc-400 text-sm">Current prize</div>
              </div>
            </div>

            <div className="mt-6 grid sm:grid-cols-3 gap-4">
              <div className="rounded-2xl bg-zinc-950/60 border border-zinc-800 p-4">
                <Label>Chance</Label>
                <div className="text-xl font-semibold">{pctFromPpm(chancePpm)}%</div>
              </div>
              <div className="rounded-2xl bg-zinc-950/60 border border-zinc-800 p-4">
                <Label>Entry fee</Label>
                <div className="text-xl font-semibold">{formatEther(feeWei || 0n)} ETH</div>
              </div>
              <div className="rounded-2xl bg-zinc-950/60 border border-zinc-800 p-4">
                <Label>Contract balance</Label>
                <div className="text-xl font-semibold">{formatEther(contractBal || 0n)} ETH</div>
              </div>
            </div>

            <div className="mt-6">
              <Label>User salt</Label>
              <div className="mt-1 flex flex-col sm:flex-row gap-3 items-center">
                <input
                  className="flex-1 w-full px-4 py-3 rounded-2xl bg-black/60 border border-zinc-800 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  placeholder="e.g. 12345"
                  value={salt}
                  onChange={(e) => setSalt(e.target.value.replace(/\D/g, ""))}
                />
                <button
                  disabled={!account || loading || !canPlay}
                  onClick={doPlay}
                  className={`px-6 py-3 rounded-2xl font-bold text-lg shadow transition ${
                    !account || loading || !canPlay
                      ? "bg-zinc-700 cursor-not-allowed"
                      : "bg-amber-500 hover:bg-amber-400 text-black"
                  }`}
                >{canPlay ? "PLAY" : "Wait next block"}</button>
              </div>
              <div className="text-xs text-zinc-400 mt-1">Any number. Adds entropy, doesn’t change odds.</div>
            </div>

            <div className="mt-4 min-h-[44px] flex items-center gap-3">
              {loading && wonState === null ? (
                <div className="relative w-full bg-zinc-700 rounded-full h-6 overflow-hidden">
                  <div className="progress-bar bg-indigo-400 h-full w-full flex items-center justify-center">
                    <span className="text-xs font-semibold text-indigo-900">{progressMessage}</span>
                  </div>
                </div>
              ) : (
                <AnimatePresence>
                  {wonState === true && (
                    <motion.div
                      key="win"
                      initial={{ scale: 0.9, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="w-full text-center px-4 py-2 rounded-xl bg-emerald-600/20 border border-emerald-500/40 text-emerald-300"
                    >
                      You WON! Payout: {formatEther(prizeWei || 0n)} ETH 🎉
                    </motion.div>
                  )}
                  {wonState === false && <LostMessage />}
                  {rejected && <RejectedMessage />}
                  {!rejected && status && <StatusMessage k="status">{status}</StatusMessage>}
                </AnimatePresence>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5">
            <div className="text-lg font-semibold">Your wallet</div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <Label>Address</Label>
                <div>{account ? shortAddr(account) : "—"}</div>
              </div>
              <div>
                <Label>Can play now</Label>
                <div className={canPlay ? "text-emerald-400" : "text-zinc-400"}>{canPlay ? "Yes" : "No"}</div>
              </div>
              <div>
                <Label>Last played block</Label>
                <div>{lastPlayedBlock?.toString?.() || "0"}</div>
              </div>
              <div>
                <Label>Current block</Label>
                <div>{currentBlock?.toString?.() || "0"}</div>
              </div>
              <div>
                <Label>Your pending prize</Label>
                <div>{formatEther(pendingMine || 0n)} ETH</div>
              </div>
            </div>
            <button
              onClick={doClaim}
              disabled={!account || loading || pendingMine === 0n}
              className={`mt-4 w-full px-4 py-2 rounded-2xl border ${
                pendingMine === 0n ? "bg-zinc-800 text-zinc-400 border-zinc-700" : "bg-emerald-500 text-black border-transparent hover:bg-emerald-400"
              }`}
            >Claim</button>
          </div>

          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5">
            <div className="text-lg font-semibold">Fund the pot</div>
            <div className="mt-3 flex gap-2">
              <input
                className="flex-1 px-4 py-2 rounded-xl bg-black/60 border border-zinc-800 focus:outline-none focus:ring-2 focus:ring-amber-500"
                placeholder="Amount in ETH (e.g. 0.01)"
                value={fundAmt}
                onChange={(e) => setFundAmt(e.target.value)}
              />
              <button
                onClick={() => doFund(fundAmt || "0")}
                disabled={!account || loading || !fundAmt}
                className="px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-400 text-black font-semibold"
              >Fund</button>
            </div>
            <div className="text-xs text-zinc-400 mt-2">Anyone can fund. ETH stays in the contract.</div>
          </div>

          {isOwner && (
            <div className="rounded-3xl border border-amber-700/40 bg-amber-900/10 p-5">
              <div className="text-lg font-semibold">Owner Panel</div>
              <div className="grid grid-cols-3 gap-3 mt-3 text-sm">
                <div>
                  <Label>Prize (ETH)</Label>
                  <input className="w-full mt-1 px-3 py-2 rounded-xl bg-black/60 border border-amber-700/40 focus:outline-none" value={pPrize} onChange={(e)=>setPPrize(e.target.value)} />
                </div>
                <div>
                  <Label>Entry fee (ETH)</Label>
                  <input className="w-full mt-1 px-3 py-2 rounded-xl bg-black/60 border border-amber-700/40 focus:outline-none" value={pFee} onChange={(e)=>setPFee(e.target.value)} />
                </div>
                <div>
                  <Label>Chance (%)</Label>
                  <input className="w-full mt-1 px-3 py-2 rounded-xl bg-black/60 border border-amber-700/40 focus:outline-none" value={pPct} onChange={(e)=>setPPct(e.target.value)} />
                </div>
              </div>
              <button
                onClick={applyParams}
                disabled={!account || loading}
                className="mt-4 w-full px-4 py-2 rounded-2xl bg-amber-500 text-black font-bold hover:bg-amber-400"
              >Update Parameters</button>
              <div className="text-xs text-amber-200/70 mt-2">Reminder: on-chain RNG is manipulable; keep prizes small on mainnet.</div>
            </div>
          )}

          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5">
            <div className="text-lg font-semibold">Activity</div>
            <div className="mt-2 space-y-1 text-sm max-h-60 overflow-auto">
              {logLines.length === 0 && <div className="text-zinc-400">No activity yet.</div>}
              {logLines.map((l, idx) => (
                <div key={idx} className="text-zinc-300">
                  • {l.txHash ? (
                    <a
                      href={`https://sepolia.etherscan.io/tx/${l.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      {l.text}
                    </a>
                  ) : (
                    l.text
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="mx-auto max-w-6xl px-4 py-10 text-xs text-zinc-500">
        <div>
          <span className="font-semibold text-zinc-300">Disclaimer:</span> The lottery is free – just connect your wallet to join. No hidden costs, just a chance to win big!
        </div>
        <div className="mt-1">Contract: {CONTRACT_ADDRESS}</div>
      </div>
    </div>
  );
}
