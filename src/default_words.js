// Default banned words loaded into every group. Matching is whole-word,
// case-insensitive and unicode-normalized (see moderation.js).
// Single words are space-separated on one line. Phrases (spam/scam) are
// one per line. Underscores in a word stand for a space. Duplicates are
// removed at load time. Edit this file to change the defaults.

const ENGLISH_PROFANITY = `
ass asshole arse arsehole bastard bastards bitch bitches bitchy bollocks
bullshit cock cocks cocksucker crap cunt cunts damn dick dickhead dicks dildo
douche douchebag fag faggot fuck fucked fucker fuckers fucking fuckoff fuckup
handjob jackass jerkoff jizz kike labia nigga nigger penis piss pissed poop
porn porno pornography prick pricks pussy queer retard retarded scrotum shag
shit shithead shitty skank slut sluts smegma spastic suck sucker tit tits
titties twat vagina wank wanker whore whores
`;

const ENGLISH_VARIANTS = `
a55 a$$ azz b1tch b!tch bi7ch biatch bitchass bullsh1t c0ck cvnt d1ck dck dik
f4ck f4g fck fcuk fckin fcking fk fkn fku fuk fuc fvck fuckin fukin fukkin
fukken fukk fuxx h0e n1gga n1gger pu55y pus5y pussi pvssy s3x sh1t sh!t sht
shyt shiit sl0t w4nk w4nker wh0re whor3 blowjob boob boobs blow_job dipshit
dumbass dumbfuck dyke fellate fellatio gangbang hooker incest jerking knob
lesbo masturbate masturbating molest motherfucker mofo nutsack pedo pedophile
pedophilia prostitute prostitution rimjob shemale skanky sodomy spunk
scumbag stripper tard thot tosser tranny turd twerk vulva wanking wetback
whorehouse
`;

const HINGLISH_ABUSE = `
bhenchod behenchod bhenchodd bhnchod bhosdi bhosdike bhosadi bhosdiwala
bhosdiwale bhosdiwali bhosda bhosdaa madarchod madarchodd madarjaat bhadwa
bhadwe bhadva bhadve chutiya chutiye chutiyapa chutiyaa chutya chutiyon
chutiyo chutiyar choot chootiya chut chodu chod chodna chodne chudai chudaai
chudayi chudne chudwa chudu lund lundh lunde lauda laude lodu lavda lavde
lavdi randi randii randwa gaand gaandu gandu gaandmara gaandmaar gandmaar
harami haramkhor haraami haramzada haramzadi kamina kamini kaminey kaminay
kutta kutte kutiya kutti kuttiya suar suara suwar saala saale sala sali
behen behan maa_ki teri_maa teri_behen teri_maa_ka teri_bhen randi_ke
rundi randibaaz hijda hijra hijde napunsak jhaat jhaato jhaatu jhant jhatu
bakchod bakchodi bakchodo bakwas bewakoof bevkoof gadha gadhe gadhaa tharki
tharkee gashti gashtee bhadhwa bhadhwe bhadhva bhadvi bhadwi gote goti
chhinaal chinaal chhinnal chinal chhed chhedu kamchor kamchod kamchodi
kaam_chor kaam_chod madar mader chakke chakka chakkaa lundchus choos chus
chusna chusti chusle maachod maachodd ma_chod mummy_chod kaminapan
chapri chaprii gandmarne gaandmarao gadhi bewkoofi bewkoof bevakoof
nalayak nalaayak nikamma nikamme nikkamma ghatiya tatti hagna pakau
mugalsala mugaleshaala raand rande randiyan randiya randipan randi_khana
kothewaali kothewali kotha_wali haramkhori haramkhore haraamkhor bhosdiyon
bhosdi_ki randi_ka bhosdiwaala chodu_ chudwaa chudwa_ bhenchod_
`;

const SPAM_AND_SCAM_PHRASES = `
free money
earn daily
double your money
guaranteed profit
crypto giveaway
send me your seed
click here to claim
work from home earn
make money fast
make money online
easy money
quick cash
get rich quick
investment opportunity
passive income
unlimited income
risk free investment
100 percent profit
guaranteed returns
double your investment
forex signals
binary options
copy trading
pump and dump
join my channel
join my group
join now
limited offer
act now
last chance
exclusive offer
limited spots
claim your reward
claim your prize
claim your bonus
you have won
you won
congratulations you won
lottery winner
lucky draw
airdrop
free tokens
free bitcoin
free crypto
free nft
free usdt
usdt giveaway
eth giveaway
bitcoin giveaway
send crypto
double crypto
wallet recovery
wallet support
customer care helpline
refund process
account blocked
account suspended
verify your account
update your password
reset your password
login now
your account will be deleted
share otp
send otp
share your code
loan approved
instant loan
loan without documents
no documents needed
cheap loan
credit card approval
sex chat
video call girls
call girls
escort service
hot girls
onlyfans leak
leaked video
nude video
adult content
dating site
sugar daddy
sugar mommy
sugar baby
network marketing
pyramid scheme
ponzi scheme
recruit members
refer and earn
buy followers
cheap followers
buy views
buy subscribers
telegram members
work from mobile
part time job
daily payment
earn from home
online job
data entry job
paid survey
click and earn
join for free
joining bonus
signup bonus
welcome bonus
free trial
hack account
hack instagram
hack facebook
crack software
cracked app
mod apk
free netflix
free spotify
private key
secret phrase
recovery phrase
metamask support
ledger support
trust wallet support
binance support
coinbase support
`;

const ABUSE_PHRASES = `
kill yourself
go to hell
shut up
piece of shit
son of a bitch
nobody likes you
hate you
`;

function tokenize(text) {
  return text
    .split(/\s+/)
    .map((w) => w.trim().replace(/_/g, " ").toLowerCase())
    .filter((w) => w.length >= 2);
}

function lines(text) {
  return text
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length >= 2);
}

// Deduplicated, sorted list of default words and phrases.
export const DEFAULT_WORDS = Object.freeze(
  [
    ...new Set([
      ...tokenize(ENGLISH_PROFANITY),
      ...tokenize(ENGLISH_VARIANTS),
      ...tokenize(HINGLISH_ABUSE),
      ...lines(SPAM_AND_SCAM_PHRASES),
      ...lines(ABUSE_PHRASES),
    ]),
  ].sort(),
);
