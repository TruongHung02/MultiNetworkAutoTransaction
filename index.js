const ethers = require('ethers');
const fs = require('fs');
const readline = require('readline');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const networks = config.networks;

const WALLET_FILE = 'wallets.txt';
const PK_FILE = 'pk.txt';
const PROXY_FILE = 'proxies.txt';
const FAUCET_API = networks.somnia.faucetApi;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

// Quản lý Proxy
function loadProxies() {
    try {
        const content = fs.readFileSync(PROXY_FILE, 'utf8');
        return content.split('\n')
            .map(line => line.trim())
            .filter(line => line && line.length > 0);
    } catch (error) {
        console.error('Lỗi khi tải proxy:', error.message);
        return [];
    }
}

function getRandomProxy(proxies) {
    if (!proxies.length) return null;
    return proxies[Math.floor(Math.random() * proxies.length)];
}

function createProxyAgent(proxy) {
    if (!proxy) return null;

    const [auth, hostPort] = proxy.includes('@') ? proxy.split('@') : [null, proxy];
    const [host, port] = hostPort ? hostPort.split(':') : proxy.split(':');

    const proxyOptions = {
        host,
        port: parseInt(port),
        ...(auth && {
            auth: auth.includes(':') ? auth : `${auth}:`
        })
    };

    if (proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
        const proxyType = proxy.startsWith('socks5') ? 'SOCKS5' : 'SOCKS4';
        console.log(`Proxy ${proxyType} từ proxies.txt được sử dụng: ${proxy}`);
        return new SocksProxyAgent(`socks${proxy.startsWith('socks5') ? 5 : 4}://${proxy.replace(/^socks[4-5]:\/\//, '')}`);
    }
    console.log(`Proxy HTTP từ proxies.txt được sử dụng: ${proxy}`);
    return new HttpsProxyAgent(`http://${proxy}`);
}

// Client HTTP cải tiến với hỗ trợ proxy và logic thử lại
async function makeRequest(url, options = {}, retries = 3) {
    const proxies = loadProxies();
    let proxy = getRandomProxy(proxies);
    let attempt = 0;

    while (attempt < retries) {
        const agent = proxy ? createProxyAgent(proxy) : null;
        if (!proxy) {
            console.log('Không có proxy nào được sử dụng cho yêu cầu này');
        }

        try {
            const response = await axios({
                url,
                ...options,
                timeout: 10000, // Đặt thời gian chờ là 10 giây
                ...(agent && { httpsAgent: agent, httpAgent: agent })
            });
            return response;
        } catch (error) {
            attempt++;
            if (error.code === 'EAI_AGAIN') {
                console.error(`Lỗi EAI_AGAIN ở lần thử ${attempt}/${retries} với proxy: ${proxy || 'không có proxy'}`);
                if (attempt < retries) {
                    console.log('Thử lại với proxy khác...');
                    proxy = getRandomProxy(proxies); // Thay proxy cho lần thử tiếp theo
                    await new Promise(resolve => setTimeout(resolve, 2000)); // Chờ 2 giây trước khi thử lại
                    continue;
                }
            }
            throw new Error(`Yêu cầu thất bại sau ${retries} lần thử${proxy ? ' với proxy ' + proxy : ''}: ${error.message}`);
        }
    }
}

function loadPrivateKeys() {
    try {
        const content = fs.readFileSync(PK_FILE, 'utf8');
        return content.split('\n')
            .map(line => line.trim())
            .filter(line => line && line.length > 0);
    } catch (error) {
        console.error('Lỗi khi tải khóa riêng:', error.message);
        return [];
    }
}

async function selectWallet(network) {
    const privateKeys = loadPrivateKeys();
    if (privateKeys.length === 0) {
        throw new Error('Không tìm thấy khóa riêng trong pk.txt');
    }

    console.log('\n=== Ví Có Sẵn ===');
    const provider = new ethers.JsonRpcProvider(networks[network].rpc);

    const wallets = await Promise.all(privateKeys.map(async (pk, index) => {
        const wallet = new ethers.Wallet(pk, provider);
        const balance = await provider.getBalance(wallet.address);
        return {
            index,
            address: wallet.address,
            privateKey: pk,
            balance: ethers.formatEther(balance)
        };
    }));

    wallets.forEach((wallet, index) => {
        console.log(`${index + 1}. Địa chỉ: ${wallet.address}`);
        console.log(`   Số dư: ${wallet.balance} ${networks[network].symbol}\n`);
    });

    const selection = parseInt(await askQuestion('Chọn ví (nhập số): ')) - 1;
    if (selection < 0 || selection >= wallets.length) {
        throw new Error('Lựa chọn ví không hợp lệ');
    }

    return wallets[selection];
}

function randomDelay(min, max) {
    const delay = (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
    return new Promise(resolve => setTimeout(resolve, delay));
}

function saveWalletToFile(address, privateKey) {
    const walletData = `${address}:${privateKey}\n`;
    fs.appendFileSync(WALLET_FILE, walletData);
}

function generateNewWallet() {
    const wallet = ethers.Wallet.createRandom();
    return {
        address: wallet.address,
        privateKey: wallet.privateKey
    };
}

async function claimFaucet(address) {
    try {
        const response = await makeRequest(FAUCET_API, {
            method: 'POST',
            data: { address },
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
            }
        });

        if (response.data.success) {
            return {
                success: true,
                hash: response.data.data.hash,
                amount: response.data.data.amount
            };
        }
        return { success: false, error: 'Yêu cầu faucet thất bại' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleFaucetClaims() {
    try {
        console.log(`Đang tải proxy từ ${PROXY_FILE}...`);
        const proxies = loadProxies();
        console.log(`Tìm thấy ${proxies.length} proxy`);

        const numWallets = parseInt(await askQuestion('Bạn muốn tạo bao nhiêu ví để yêu cầu faucet? '));

        if (isNaN(numWallets) || numWallets <= 0) {
            console.error('Số lượng ví phải là số dương!');
            return;
        }

        console.log('\nBắt đầu quá trình tạo ví và yêu cầu faucet...');
        console.log(`Ví sẽ được lưu vào: ${WALLET_FILE}\n`);

        for (let i = 0; i < numWallets; i++) {
            const wallet = generateNewWallet();
            console.log(`\nVí ${i + 1}/${numWallets}:`);
            console.log(`Địa chỉ: ${wallet.address}`);

            saveWalletToFile(wallet.address, wallet.privateKey);

            console.log('Đang cố gắng yêu cầu faucet...');
            const result = await claimFaucet(wallet.address);

            if (result.success) {
                console.log(`Yêu cầu thành công! Mã TX: ${result.hash}`);
                console.log(`Số lượng: ${ethers.formatEther(result.amount)} ${networks.somnia.symbol}`);
            } else {
                console.log(`Yêu cầu thất bại: ${result.error}`);
            }

            if (i < numWallets - 1) {
                console.log('\nChờ 5 giây trước khi xử lý ví tiếp theo...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        console.log('\nQuá trình hoàn tất!');
        console.log(`Tổng số ví đã tạo: ${numWallets}`);
        console.log(`Ví đã được lưu vào: ${WALLET_FILE}`);
    } catch (error) {
        console.error('Lỗi:', error.message);
    }
}

async function handleTokenTransfers(network) {
    try {
        const selectedWallet = await selectWallet(network);
        const provider = new ethers.JsonRpcProvider(networks[network].rpc);
        const wallet = new ethers.Wallet(selectedWallet.privateKey, provider);

        console.log(`\nMạng đã chọn: ${networks[network].name}`);
        console.log(`Ký hiệu token: ${networks[network].symbol}`);
        console.log(`Sử dụng ví: ${selectedWallet.address}`);

        const amountPerTx = await askQuestion('Nhập số lượng token cho mỗi giao dịch: ');
        const numberOfTx = await askQuestion('Nhập số lượng giao dịch cần thực hiện: ');
        const minDelay = await askQuestion('Nhập thời gian trì hoãn tối thiểu (giây) giữa các giao dịch: ');
        const maxDelay = await askQuestion('Nhập thời gian trì hoãn tối đa (giây) giữa các giao dịch: ');

        if (isNaN(amountPerTx) || isNaN(numberOfTx) || isNaN(minDelay) || isNaN(maxDelay)) {
            console.error('Tất cả đầu vào phải là số!');
            return;
        }

        for (let i = 0; i < numberOfTx; i++) {
            console.log(`\nĐang xử lý giao dịch ${i + 1} trong số ${numberOfTx}`);

            const newWallet = generateNewWallet();
            console.log(`Đã tạo địa chỉ người nhận: ${newWallet.address}`);
            saveWalletToFile(newWallet.address, newWallet.privateKey);

            const tx = {
                to: newWallet.address,
                value: ethers.parseEther(amountPerTx.toString())
            };

            const transaction = await wallet.sendTransaction(tx);
            console.log(`Giao dịch đã gửi: ${transaction.hash}`);
            console.log(`Xem trên explorer: ${networks[network].explorer}/tx/${transaction.hash}`);

            await transaction.wait();

            if (i < numberOfTx - 1) {
                const delay = await randomDelay(parseInt(minDelay), parseInt(maxDelay));
                console.log(`Chờ ${delay/1000} giây trước giao dịch tiếp theo...`);
            }
        }

        console.log('\nTất cả giao dịch đã hoàn tất thành công!');
    } catch (error) {
        console.error('Lỗi:', error.message);
    }
}

async function checkLayerhubActivity(address) {
    try {
        const response = await makeRequest(`https://layerhub.xyz/be-api/wallets/monad_testnet/${address}`, {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Connection': 'keep-alive',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin',
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    } catch (error) {
        console.error('Lỗi khi kiểm tra hoạt động Layerhub:', error.message);
        return null;
    }
}

const stakingAbi = [
    "function stake() payable",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function withdraw(uint256 amount) external returns (bool)",
    {
        name: 'withdrawWithSelector',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ type: 'uint256', name: 'amount' }],
        outputs: [{ type: 'bool' }],
        selector: '0x30af6b2e'
    }
];

const molandakAbi = [
    "function stake(uint256 _poolId) payable"
];

async function stakeMolandakhubQuest(wallet) {
    try {
        const stakeAmount = ethers.parseEther('0.1');
        const STAKING_CONTRACT = '0xc803D3Cbe1B4811442a4502153685a235Ea90741';
        const POOL_ID = 2;

        const questContract = new ethers.Contract(
            STAKING_CONTRACT,
            molandakAbi,
            wallet
        );

        console.log('\nĐang stake 0.1 MON cho Nhiệm vụ Molandakhub...');

        const balance = await wallet.provider.getBalance(wallet.address);
        if (balance < stakeAmount) {
            throw new Error('Số dư không đủ để stake');
        }

        const stakeTx = await questContract.stake(POOL_ID, {
            value: stakeAmount,
            gasLimit: 1000000,
            maxFeePerGas: ethers.parseUnits('61.5', 'gwei'),
            maxPriorityFeePerGas: ethers.parseUnits('1.5', 'gwei')
        });

        console.log(`Giao dịch đã gửi: ${stakeTx.hash}`);
        console.log(`Xem trên explorer: ${networks.monad.explorer}/tx/${stakeTx.hash}`);

        const receipt = await stakeTx.wait();

        if (receipt.status === 1) {
            console.log('Stake nhiệm vụ thành công!');
            return true;
        } else {
            console.log('Stake nhiệm vụ thất bại!');
            return false;
        }
    } catch (error) {
        console.error('Lỗi stake nhiệm vụ:', error.message);
        return false;
    }
}

async function handleMonadStaking() {
    try {
        const selectedWallet = await selectWallet('monad');
        const provider = new ethers.JsonRpcProvider(networks.monad.rpc);
        const wallet = new ethers.Wallet(selectedWallet.privateKey, provider);

        console.log('\n=== Hoạt động Stake Monad ===');
        console.log(`Sử dụng ví: ${selectedWallet.address}`);
        console.log('1. Stake MON trên kitsu.xyz');
        console.log('2. Rút stake MON trên kitsu.xyz');
        console.log('3. Stake 0.1 MON (Nhiệm vụ Molandakhub)');
        console.log('4. Kiểm tra Xếp hạng Hoạt động Ví');
        console.log('0. Quay lại');

        const choice = await askQuestion('\nChọn hoạt động: ');

        const stakingContract = new ethers.Contract(
            networks.monad.contracts.staking,
            stakingAbi,
            wallet
        );

        switch (choice) {
            case '1':
                const amountToStake = await askQuestion('Nhập số lượng MON để stake: ');

                if (isNaN(amountToStake) || amountToStake <= 0) {
                    console.error('Số lượng không hợp lệ!');
                    return;
                }

                console.log(`\nĐang stake ${amountToStake} MON...`);

                try {
                    const balance = await provider.getBalance(wallet.address);
                    const stakeAmount = ethers.parseEther(amountToStake.toString());

                    if (balance < stakeAmount) {
                        console.error('Số dư không đủ để stake');
                        return;
                    }

                    const stakeTx = await stakingContract.stake({
                        value: stakeAmount
                    });

                    console.log(`Giao dịch đã gửi: ${stakeTx.hash}`);
                    console.log(`Xem trên explorer: ${networks.monad.explorer}/tx/${stakeTx.hash}`);

                    const stakeReceipt = await stakeTx.wait();
                    console.log('\nXác nhận giao dịch stake!');

                    if (stakeReceipt.status === 1) {
                        console.log('Stake thành công!');
                    } else {
                        console.log('Stake thất bại!');
                    }
                } catch (error) {
                    console.error('Lỗi stake:', error.message);
                }
                break;

            case '2':
                const amountToUnstake = await askQuestion('Nhập số lượng sMON để rút stake: ');

                if (isNaN(amountToUnstake) || amountToUnstake <= 0) {
                    console.error('Số lượng không hợp lệ!');
                    return;
                }

                console.log(`\nĐang rút stake ${amountToUnstake} sMON...`);

                try {
                    const data = ethers.concat([
                        '0x30af6b2e',
                        ethers.AbiCoder.defaultAbiCoder().encode(
                            ['uint256'],
                            [ethers.parseEther(amountToUnstake.toString())]
                        )
                    ]);

                    const unstakeTx = await wallet.sendTransaction({
                        to: networks.monad.contracts.staking,
                        data: data,
                        gasLimit: 300000
                    });

                    console.log(`Giao dịch đã gửi: ${unstakeTx.hash}`);
                    console.log(`Xem trên explorer: ${networks.monad.explorer}/tx/${unstakeTx.hash}`);

                    const unstakeReceipt = await unstakeTx.wait();
                    console.log('\nXác nhận giao dịch rút stake!');

                    if (unstakeReceipt.status === 1) {
                        console.log('Rút stake thành công!');
                    } else {
                        console.log('Rút stake thất bại!');
                    }
                } catch (error) {
                    console.error('Lỗi rút stake:', error.message);
                }
                break;

            case '3':
                await stakeMolandakhubQuest(wallet);
                break;

            case '4':
                console.log('\nĐang kiểm tra hoạt động ví...');
                const activityData = await checkLayerhubActivity(wallet.address);
                if (activityData) {
                    console.log('\nThông tin Hoạt động Ví:');
                    console.log(`Địa chỉ: ${wallet.address}`);
                    console.log(`Tổng số giao dịch: ${activityData.totalTx || 'Không có'}`);
                    console.log(`Giao dịch đầu tiên: ${activityData.firstTx || 'Không có'}`);
                    console.log(`Giao dịch cuối cùng: ${activityData.lastTx || 'Không có'}`);
                    if (activityData.rank) {
                        console.log(`Xếp hạng Hoạt động: ${activityData.rank}`);
                    }
                } else {
                    console.log('Không thể lấy dữ liệu hoạt động');
                }
                break;

            case '0':
                return;

            default:
                console.log('Lựa chọn không hợp lệ!');
                break;
        }
    } catch (error) {
        console.error('Lỗi:', error.message);
    }
}

async function handleNetworkOperations(network) {
    while (true) {
        console.log(`\n=== Hoạt động trên ${networks[network].name} ===`);
        if (network === 'somnia') {
            console.log('1. Tạo Ví & Yêu cầu Faucet');
            console.log('2. Chuyển Token');
        } else if (network === 'monad') {
            console.log('1. Chuyển Token');
            console.log('2. Hoạt động Stake');
        } else if (network === 'nexus') {
            console.log('1. Chuyển Token');
        } else if (network === 'zeroGravity') { // Dòng dành riêng cho 0G Testnet
            console.log('1. Chuyển Token');
        }
        console.log('0. Quay lại Lựa chọn Mạng');

        const choice = await askQuestion('\nChọn hoạt động: ');

        switch (network) {
            case 'somnia':
                switch (choice) {
                    case '1':
                        await handleFaucetClaims();
                        break;
                    case '2':
                        await handleTokenTransfers('somnia');
                        break;
                    case '0':
                        return;
                    default:
                        console.log('Lựa chọn không hợp lệ!');
                }
                break;

            case 'monad':
                switch (choice) {
                    case '1':
                        await handleTokenTransfers('monad');
                        break;
                    case '2':
                        await handleMonadStaking();
                        break;
                    case '0':
                        return;
                    default:
                        console.log('Lựa chọn không hợp lệ!');
                }
                break;

            case 'nexus':
                switch (choice) {
                    case '1':
                        await handleTokenTransfers('nexus');
                        break;
                    case '0':
                        return;
                    default:
                        console.log('Lựa chọn không hợp lệ!');
                }
                break;

            case 'zeroGravity': // Khối dành riêng cho 0G Testnet
                switch (choice) {
                    case '1':
                        await handleTokenTransfers('zeroGravity');
                        break;
                    case '0':
                        return;
                    default:
                        console.log('Lựa chọn không hợp lệ!');
                }
                break;
        }
    }
}

async function showMenu() {
    while (true) {
        console.log('\n=== BOT CRYPTO ĐA MẠNG | ZERO2HERO ===');
        console.log('1. Mạng Somnia');
        console.log('2. Mạng Monad');
        console.log('3. Mạng Nexus');
        console.log('4. 0G Testnet');
        console.log('5. Thoát');

        const choice = await askQuestion('\nChọn mạng (1-5): ');

        switch (choice) {
            case '1':
                await handleNetworkOperations('somnia');
                break;
            case '2':
                await handleNetworkOperations('monad');
                break;
            case '3':
                await handleNetworkOperations('nexus');
                break;
            case '4':
                await handleNetworkOperations('zeroGravity');
                break;
            case '5':
                console.log('Cảm ơn bạn đã sử dụng bot này!');
                rl.close();
                process.exit(0);
            default:
                console.log('Lựa chọn không hợp lệ!');
        }
    }
}

// Khởi động ứng dụng
console.log('Đang khởi động Bot Đa Mạng...');
showMenu().catch(console.error);