import { fetchSupportedLanguages as fetchProviderLanguages, translateTexts } from "./src/lib/translationClient.ts";
import { LOCAL_ONLY_LANGUAGES, STATIC_DICTIONARIES, STATIC_LANGUAGES } from "./src/lib/i18n/dictionaries.ts";

const LANGUAGE_KEY = "smartwatts-language";
const DEFAULT_LANGUAGES = [
  { code: "en", name: "English" },
  { code: "tl", name: "Tagalog" },
  ...STATIC_LANGUAGES,
];
// Languages with a local dictionary: remote translation is only used for strings they lack.
const hasLocalDictionary = (language) => language === "tl" || Boolean(STATIC_DICTIONARIES[language]);
// Whether a string still needs Google Cloud Translation for this language.
const needsRemote = (language, original, local) =>
  language !== "en" && !LOCAL_ONLY_LANGUAGES.has(language) && Boolean(original) && (!hasLocalDictionary(language) || local.trim() === original.trim());
let supportedLanguages = DEFAULT_LANGUAGES;
let activeLanguage = null;
let translationRevision = 0;
const translatedCache = new Map();
const queuedTranslations = new Map();
let translationFlushTimer = null;
const translations = {
  "Consumption Calendar": "Kalendaryo ng Konsumo",
  "Meralco Business Centers": "Mga Meralco Business Center",
  "Save plan": "I-save ang plano",
  "Get directions": "Kumuha ng direksiyon",
  "Find a Business Center": "Maghanap ng Business Center",
  "Not published": "Hindi nakalathala",
  "Branch details": "Detalye ng sangay",
  "Operating hours": "Oras ng operasyon",
  "Address": "Address",
  "Name": "Pangalan",
  "Category": "Kategorya",
  "Power (watts)": "Lakas (watts)",
  "Quantity": "Dami",
  "Hours used per day": "Oras ng paggamit kada araw",
  "Days used per week": "Araw ng paggamit kada linggo",
  "Period start": "Simula ng panahon",
  "Period end": "Katapusan ng panahon",
  "Billed kWh": "Siningil na kWh",
  "Total current charges (₱)": "Kabuuang singil ngayong buwan (₱)",
  "Your rate (₱ per kWh)": "Iyong rate (₱ kada kWh)",
  "Loading…": "Naglo-load…",
  "Branch, city, or province": "Sangay, lungsod, o lalawigan",
  "Province / area": "Lalawigan / lugar",
  "All areas": "Lahat ng lugar",
  "Search": "Maghanap",
  "Usage Patterns": "Mga Pattern ng Konsumo",
  "Patterns": "Pattern",
  "My Appliances": "Aking mga Appliance",
  "Savings Simulator": "Simulator ng Pagtitipid",
  "Bill Upload & History": "Pag-upload at Kasaysayan ng Bill",
  "Plans": "Mga Plano",
  "ACCOUNT": "ACCOUNT",
  "Workspace": "Workspace",
  "PROPERTY": "ARI-ARIAN",
  "MY RENTAL": "AKING INUUPAHAN",
  "MY PRIVATE ENERGY": "AKING PRIBADONG ENERHIYA",
  "Overview": "Pangkalahatang-tanaw",
  "Property Analytics": "Pagsusuri ng Ari-arian",
  "Units & Tenants": "Mga Unit at Nangungupahan",
  "Meters & Allocation": "Mga Metro at Paghahati",
  "Meter Readings": "Mga Pagbasa ng Metro",
  "Utility Bills": "Mga Bill ng Kuryente",
  "Tenant Statements": "Mga Statement ng Nangungupahan",
  "Subscription": "Subskripsyon",
  "Audit Log": "Talaan ng Audit",
  "My Statements": "Aking mga Statement",
  "My Meter History": "Kasaysayan ng Aking Metro",
  "Sample data": "Sample na datos",
  "Estimate": "Tantiya",
  "Official utility bill": "Opisyal na bill ng kuryente",
  "Measured · utility meter": "Nasukat · metro ng utility",
  "Measured · private submeter": "Nasukat · pribadong submetro",
  "Not individually measured": "Hindi indibidwal na nasukat",
  "Allocation (agreed share)": "Paghahati (napagkasunduang bahagi)",
  "Typical Load": "Karaniwang Load",
  "Usage Profile": "Profile ng Konsumo",
  "Sign-in & security": "Pag-sign in at seguridad",
  "Create account": "Gumawa ng account",
  "Sign in": "Mag-sign in",
  "Sign out": "Mag-sign out",
  "Add an appliance": "Magdagdag ng appliance",
  "Save appliance": "I-save ang appliance",
  "Registered appliances": "Mga nakarehistrong appliance",
  "Estimated monthly usage": "Tinantiyang buwanang konsumo",
  "Simulate": "I-simulate",
  "Save bill": "I-save ang bill",
  "Billing history": "Kasaysayan ng bill",
  "SmartWatts plans": "Mga plano ng SmartWatts",
  "Tenant billing workflows require legal and regulatory review before production use. SmartWatts does not collect payments, disconnect service, or certify compliance.": "Kailangang suriin ng abogado at ng mga regulator ang proseso ng paniningil sa nangungupahan bago gamitin nang totoo. Hindi naniningil ng bayad, hindi pumuputol ng serbisyo, at hindi nagpapatunay ng pagsunod sa regulasyon ang SmartWatts.",
  "Dashboard": "Buod",
  "Real-time Monitor": "Real-time na Monitor",
  "Usage History": "Kasaysayan ng Konsumo",
  "Analytics": "Pagsusuri",
  "Device Monitor": "Mga Device",
  "Energy Goals": "Mga Layunin sa Enerhiya",
  "Energy goals": "Mga layunin sa enerhiya",
  "Rewards & Badges": "Mga Gantimpala at Badge",
  "Watts Coins": "Watts Coins",
  "Earn coins through daily check-ins and verified monthly energy savings.": "Mag-ipon ng coin sa araw-araw na check-in at kumpirmadong pagtitipid ng kuryente kada buwan.",
  "Earn More Coins": "Mag-ipon pa ng Coins",
  "View Watts Coins": "Tingnan ang Watts Coins",
  "My Watts Coins": "Watts Coins Ko",
  "ALL HISTORY": "LAHAT NG KASAYSAYAN",
  "EARNING": "PAGKITA",
  "SPENDING": "PAGGAMIT",
  "7-DAY DAILY CHECK-IN STREAK": "7-ARAW NA SUNOD-SUNOD NA CHECK-IN",
  "Small habits, real rewards.": "Maliit na gawi, tunay na gantimpala.",
  "Earn 5.00 Watts Coins (₱5.00) for a complete seven-day cycle.": "Makakuha ng 5.00 Watts Coins (₱5.00) sa kumpletong pitong araw.",
  "I completed one energy-saving habit today.": "Nakumpleto ko ang isang gawaing nakakatipid ng kuryente ngayong araw.",
  "Check in to get coins": "Mag-check in para makakuha ng coins",
  "Checked in today": "Nakapag-check in na ngayong araw",
  "Complete today's energy-saving habit check before claiming your coins.": "Kumpletuhin muna ang pagtitipid ng kuryente ngayong araw bago kunin ang coins.",
  "You already checked in today. Come back tomorrow!": "Nakapag-check in ka na ngayong araw. Bumalik bukas!",
  "Watts Coins Balance": "Balanse ng Watts Coins",
  "History →": "Kasaysayan →",
  "Your earned coins will appear here.": "Lalabas dito ang mga nakuha mong coin.",
  "Locked · Pending for Next Bill": "Naka-lock · Para sa susunod na bill",
  "Coins become usable only during your monthly bill payment or subscription renewal window.": "Magagamit lang ang coins sa panahon ng pagbabayad ng buwanang bill o pag-renew ng subscription.",
  "Monthly kWh Reduction Bonus": "Bonus sa Bawas kWh Kada Buwan",
  "Monthly bill source": "Pinagmulan ng buwanang bill",
  "Home setup": "Uri ng tirahan",
  "Tier 1 · Personal homeowner": "Tier 1 · Sariling tahanan",
  "Tier 2 · Condo / apartment resident": "Tier 2 · Nakatira sa condo / apartment",
  "Meralco electricity bill": "Meralco electricity bill",
  "Condo / apartment statement of account": "Statement of account ng condo / apartment",
  "Sub-meter reading slip": "Resibo ng sub-meter reading",
  "Baseline monthly consumption (kWh)": "Panimulang konsumo kada buwan (kWh)",
  "Baseline billing period end": "Huling araw ng panimulang billing period",
  "Use the latest verified bill or statement so SmartWatts has a starting point.": "Gamitin ang pinakabagong kumpirmadong bill o statement bilang panimulang datos ng SmartWatts.",
  "Analytics report generated and downloaded.": "Nagawa at na-download ang ulat ng Analytics.",
  "Preparing your Analytics report…": "Inihahanda ang ulat ng Analytics…",
  "Unable to export analytics report. Please try again.": "Hindi ma-export ang ulat ng Analytics. Subukan muli.",
  "Preparing usage record download…": "Inihahanda ang pag-download ng usage record…",
  "Preparing usage history export…": "Inihahanda ang export ng kasaysayan ng konsumo…",
  "I reviewed this bill or statement and confirm its billing period and kWh value are correct.": "Sinuri ko ang bill o statement at kinukumpirma kong tama ang billing period at kWh.",
  "My Watts Coins": "Watts Coins Ko",
  "ALL HISTORY": "LAHAT NG KASAYSAYAN",
  "EARNING": "PAGKITA",
  "SPENDING": "PAGGAMIT",
  "No coin transactions yet. Complete a daily check-in or save a lower monthly bill.": "Wala pang transaksyon. Mag-check in araw-araw o makatipid sa buwanang bill.",
  "Watts Coins Discount": "Diskwento gamit ang Watts Coins",
  "Apply coins at payment": "Gamitin ang coins sa pagbabayad",
  "Locked / Pending for Next Bill": "Naka-lock / Para sa susunod na bill",
  "Billing & Payments": "Pagsingil at Pagbabayad",
  "Bill History": "Kasaysayan ng Bill",
  "Rates Overview": "Mga Rate",
  "Notifications": "Mga Abiso",
  "Account Settings": "Mga Setting ng Account",
  "Help & Support": "Tulong at Suporta",
  "About Team": "Tungkol sa Team",
  "MONITOR": "SUBAYBAYAN",
  "SAVE & EARN": "MAGTIPID AT MAG-IPON",
  "BILLING": "SINGILAN",
  "SETTINGS": "MGA SETTING",
  "MORE": "IBA PA",
  "Dashboard": "Dashboard",
  "Here's what's happening with your electricity today.": "Narito ang mga update sa konsumo ng kuryente mo ngayong araw.",
  "Build better habits and track your household energy targets.": "Bumuo ng mabubuting gawi at subaybayan ang konsumo ng enerhiya sa bahay.",
  "Track your electricity usage as it happens.": "Subaybayan ang konsumo ng kuryente habang nangyayari ito.",
  "Review and compare your past electricity consumption.": "Suriin at ihambing ang nakaraang konsumo ng kuryente.",
  "Understand where your electricity is being consumed.": "Alamin kung saan nagagamit ang iyong kuryente.",
  "Celebrate the small steps that help you use energy wisely.": "Ipagdiwang ang maliliit na hakbang tungo sa matalinong pagtitipid ng enerhiya.",
  "Manage your account details and preferences.": "Pamahalaan ang mga detalye at kagustuhan sa iyong account.",
  "Find answers or contact the SmartWatts support team.": "Maghanap ng sagot o makipag-ugnayan sa SmartWatts support team.",
  "M MERALCO": "M MERALCO",
  "Home": "Bahay",
  "Live monitor": "Live na monitor",
  "Live": "Live",
  "Quests": "Misyon",
  "Rewards": "Gantimpala",
  "More": "Iba pa",
  "Open menu": "Buksan ang menu",
  "Close menu": "Isara ang menu",
  "Mobile navigation": "Nabigasyong pang-mobile",
  "Current Usage": "Kasalukuyang Konsumo",
  "Today's Consumption": "Konsumo Ngayong Araw",
  "This Month": "Ngayong Buwan",
  "Est. Bill Amount": "Tinatayang Halaga ng Bill",
  "As of 10:24 AM": "Noong 10:24 AM",
  "vs yesterday": "kumpara kahapon",
  "vs last month": "kumpara noong nakaraang buwan",
  "Due on May 20, 2026": "Takdang bayad sa Mayo 20, 2026",
  "May 20, 2026": "Mayo 20, 2026",
  "Apr 15": "Abr 15",
  "Apr 1–30": "Abr 1–30",
  "May 8, 2026": "Mayo 8, 2026",
  "May 2, 2026": "Mayo 2, 2026",
  "Real-time Usage": "Real-time na Konsumo",
  "Usage Breakdown": "Hati ng Konsumo",
  "(This Month)": "(Ngayong Buwan)",
  "Air Conditioner": "Aircon",
  "Refrigerator": "Refrigerador",
  "Lighting": "Ilaw",
  "Others": "Iba pa",
  "Device": "Aparato",
  "Television": "Telebisyon",
  "Washing Machine": "Makinang Panlaba",
  "Usage (kWh)": "Konsumo (kWh)",
  "Paid": "Bayad na",
  "Yesterday": "Kahapon",
  "Device Connected": "Nakakonekta ang Device",
  "A new device was added to your monitor.": "Nagdagdag ng bagong device sa iyong monitor.",
  "View Full Breakdown": "Tingnan ang Buong Detalye",
  "Top Devices": "Mga Device na Malaki ang Konsumo",
  "Account Overview": "Buod ng Account",
  "Account Name": "Pangalan sa Account",
  "Account Number": "Numero ng Account",
  "Service Address": "Address ng Serbisyo",
  "Rate": "Rate",
  "Residential": "Pambahay",
  "View Account Details": "Tingnan ang Detalye ng Account",
  "Alerts & Notifications": "Mga Alerto at Abiso",
  "View all": "Tingnan lahat",
  "High Usage Alert": "Babala sa Mataas na Konsumo",
  "Your usage is 20% higher than yesterday at this time.": "Mas mataas nang 20% ang konsumo mo kaysa kahapon sa ganitong oras.",
  "Bill is Ready": "Handa na ang Bill",
  "Your May 2026 bill is now available.": "Maaari nang tingnan ang bill mo para sa Mayo 2026.",
  "Payment Received": "Natanggap ang Bayad",
  "Thank you! Your payment of ₱1,150.00 was successful.": "Salamat! Matagumpay ang bayad mong ₱1,150.00.",
  "Bill Estimate": "Tantya ng Bill",
  "Based on your current usage": "Batay sa kasalukuyan mong konsumo",
  "Due Date": "Takdang Petsa",
  "Billing Period": "Panahon ng Pagsingil",
  "Apr 1 – Apr 30, 2026": "Abr 1 – Abr 30, 2026",
  "View Bill & Pay": "Tingnan at Bayaran ang Bill",
  "Your energy goals": "Mga layunin mo sa enerhiya",
  "Set realistic targets and celebrate your progress.": "Magtakda ng makatotohanang target at ipagdiwang ang iyong progreso.",
  "Monthly Target": "Buwanang Target",
  "Used This Month": "Nagamit Ngayong Buwan",
  "Daily Target": "Araw-araw na Target",
  "Watts Points": "Watts Points",
  "Your chosen goal": "Pinili mong layunin",
  "Average daily goal": "Karaniwang layunin kada araw",
  "Monthly energy target": "Buwanang target sa enerhiya",
  "of target": "ng target",
  "You're": "Ikaw ay",
  "kWh over your monthly target. Reduce usage to get back on track.": "kWh na lampas sa buwanang target. Bawasan ang konsumo para makabalik sa target.",
  "kWh left before reaching your monthly target.": "kWh pa bago maabot ang buwanang target.",
  "You've reached your monthly energy target. Keep it up!": "Naabot mo na ang buwanang target sa enerhiya. Ipagpatuloy ito!",
  "kWh above target": "kWh na lampas sa target",
  "kWh remaining": "kWh ang natitira",
  "Tip: AC quest = +30 XP": "Tip: Misyon sa aircon = +30 XP",
  "Your next milestone": "Susunod mong milestone",
  "Energy-aware household": "Pamilyang mulat sa enerhiya",
  "Complete all 5 quests to unlock the Energy Champion badge.": "Tapusin ang lahat ng 5 misyon para makuha ang Energy Champion badge.",
  "Adjust your monthly target": "Baguhin ang buwanang target",
  "Monthly target (kWh)": "Buwanang target (kWh)",
  "Save target": "I-save ang target",
  "Choose a monthly target between 50 and 2,000 kWh.": "Pumili ng buwanang target mula 50 hanggang 2,000 kWh.",
  "Today's quests": "Mga misyon ngayong araw",
  "quest": "misyon",
  "quests": "mga misyon",
  "Complete quest": "Tapusin ang misyon",
  "Claim": "Kunin",
  "Done": "Tapos na",
  "✓ Done": "✓ Tapos na",
  "Rewards & badges": "Mga gantimpala at badge",
  "Every energy-smart choice deserves a little celebration.": "Dapat ipagdiwang ang bawat matalinong pagpili sa enerhiya.",
  "YOUR WATTS POINTS": "WATTS POINTS MO",
  "Badge collection": "Koleksiyon ng mga Badge",
  "First Step": "Unang Hakbang",
  "Complete your first quest": "Tapusin ang unang misyon",
  "Cool Operator": "Dalubhasa sa Pagpapalamig",
  "Finish the AC quest": "Tapusin ang misyon sa aircon",
  "Phantom Hunter": "Tagahanap ng Nakatagong Konsumo",
  "Unplug standby gadgets": "Tanggalin sa saksakan ang mga di-ginagamit na gadget",
  "Daylight Dynamo": "Kaibigan ng Liwanag ng Araw",
  "Use daylight until 5 PM": "Gamitin ang liwanag ng araw hanggang 5 PM",
  "Energy Champion": "Kampeon sa Enerhiya",
  "Complete all 5 quests": "Tapusin ang lahat ng 5 misyon",
  "Consistency Star": "Bituin ng Pagkakapare-pareho",
  "Reach a 7-day streak": "Umabot sa 7 magkakasunod na araw",
  "Rocket Rank": "Antas ng Rocket",
  "Reach level 3": "Umabot sa level 3",
  "Watt Royalty": "Hari ng Watts",
  "Earn 300 points": "Makakuha ng 300 puntos",
  "✓ Unlocked": "✓ Na-unlock",
  "🔒 Locked": "🔒 Naka-lock",
  "earned": "nakuha",
  "Points and badges are demonstration features stored in this browser only. They have no cash value.": "Mga demo feature lamang ang points at badge na naka-save sa browser na ito. Wala itong katumbas na pera.",
  "Live electricity consumption": "Real-time na konsumo ng kuryente",
  "Your meter usage updates in real time.": "Real-time na nag-a-update ang konsumo ng metro mo.",
  "Current Load": "Kasalukuyang Load",
  "Peak Today": "Pinakamataas Ngayong Araw",
  "Today's Energy": "Enerhiya Ngayong Araw",
  "Average Load": "Karaniwang Load",
  "Live reading": "Live na sukat",
  "At 7:30 AM": "Noong 7:30 AM",
  "Since 12:00 AM": "Mula 12:00 AM",
  "Today's average": "Karaniwang konsumo ngayong araw",
  "Live Usage Trend": "Trend ng Live na Konsumo",
  "Meter Status": "Kalagayan ng Metro",
  "Connected": "Nakakonekta",
  "Last sync: Just now": "Huling sync: Ngayon lang",
  "Today's Peak": "Pinakamataas Ngayong Araw",
  "Recorded at 7:30 AM": "Naitala noong 7:30 AM",
  "Energy Today": "Enerhiya Ngayong Araw",
  "Estimated daily usage": "Tinatayang konsumo kada araw",
  "Consumption history": "Kasaysayan ng Konsumo",
  "Explore your energy consumption over time.": "Suriin ang konsumo ng enerhiya sa paglipas ng panahon.",
  "Last 30 days": "Nakaraang 30 araw",
  "Last 7 days": "Nakaraang 7 araw",
  "Last 12 months": "Nakaraang 12 buwan",
  "Total Consumption": "Kabuuang Konsumo",
  "Daily Average": "Pang-araw-araw na Average",
  "Highest Day": "Araw na Pinakamataas",
  "Lowest Day": "Araw na Pinakamababa",
  "Current month": "Kasalukuyang buwan",
  "This month": "Ngayong buwan",
  "Daily Consumption": "Pang-araw-araw na Konsumo",
  "Recent Usage Records": "Mga Kamakailang Tala ng Konsumo",
  "Consumption": "Konsumo",
  "Amount": "Halaga",
  "Status": "Katayuan",
  "Statement": "Statement",
  "Download": "I-download",
  "Energy analytics": "Pagsusuri ng Enerhiya",
  "Analyze your electricity usage by category and time.": "Suriin ang konsumo ng kuryente ayon sa kategorya at panahon.",
  "May 2026": "Mayo 2026",
  "April 2026": "Abril 2026",
  "Export Report": "I-export ang Ulat",
  "Total Usage": "Kabuuang Konsumo",
  "Estimated Cost": "Tinatayang Gastos",
  "Largest Consumer": "Pinakamalaking Konsumo",
  "Compared to Last Month": "Kumpara sa Nakaraang Buwan",
  "Consumption increase": "Pagtaas ng konsumo",
  "Usage by Appliance": "Konsumo Ayon sa Appliance",
  "Monthly Consumption Trend": "Buwanang Trend ng Konsumo",
  "Appliance Consumption Details": "Detalye ng Konsumo ng Appliance",
  "Connected devices": "Mga Nakakonektang Device",
  "Track appliance activity and energy consumption.": "Subaybayan ang aktibidad at konsumo ng mga appliance.",
  "Add Device": "Magdagdag ng Device",
  "Total Devices": "Kabuuang Device",
  "Currently Online": "Kasalukuyang Online",
  "Combined Load": "Pinagsamang Load",
  "Device Usage": "Konsumo ng Device",
  "Connected appliances": "Mga nakakonektang appliance",
  "Active devices": "Mga aktibong device",
  "Current demand": "Kasalukuyang demand",
  "Device energy consumption": "Konsumo ng enerhiya ng device",
  "Standby": "Naka-standby",
  "Online": "Online",
  "of total usage": "ng kabuuang konsumo",
  "View Details": "Tingnan ang Detalye",
  "Your current bill summary and payment information.": "Buod ng kasalukuyang bill at impormasyon sa pagbabayad.",
  "Total Amount Due": "Kabuuang Dapat Bayaran",
  "Energy Used": "Nagagamit na Enerhiya",
  "Last Payment": "Huling Bayad",
  "Due May 20, 2026": "Takdang bayad sa Mayo 20, 2026",
  "May 2026 statement": "Statement para sa Mayo 2026",
  "This billing period": "Ngayong panahon ng pagsingil",
  "Received Apr 15, 2026": "Natanggap noong Abr 15, 2026",
  "Current Bill": "Kasalukuyang Bill",
  "Estimated amount due": "Tinatayang halagang babayaran",
  "Due date: May 20, 2026": "Takdang petsa: Mayo 20, 2026",
  "Your estimated bill is based on current consumption.": "Batay sa kasalukuyang konsumo ang tantiya ng bill mo.",
  "Proceed to Payment": "Magpatuloy sa Pagbabayad",
  "Bill Breakdown": "Detalye ng Bill",
  "Generation Charge": "Singil sa Paglikha ng Kuryente",
  "Transmission Charge": "Singil sa Transmisyon",
  "Distribution Charge": "Singil sa Distribusyon",
  "Taxes & Other Charges": "Buwis at Iba Pang Singil",
  "Payment Methods": "Mga Paraan ng Pagbabayad",
  "Available payment channels": "Mga available na paraan ng pagbabayad",
  "Online banking · E-wallet · Payment centers": "Online banking · E-wallet · Sentro ng pagbabayad",
  "Payments are simulated in this UI demo. No real transaction will be made.": "Simulation lamang ang mga bayad sa demo na ito. Walang totoong transaksyong magaganap.",
  "Bill history": "Kasaysayan ng Bill",
  "Your statements and payment records.": "Mga statement at tala ng pagbabayad mo.",
  "All years": "Lahat ng taon",
  "Previous Statements": "Mga Nakaraang Statement",
  "Rates overview": "Buod ng mga Rate",
  "A sample breakdown of residential electricity charges.": "Halimbawang detalye ng mga singil sa kuryente para sa bahay.",
  "Estimated Average Rate": "Tinatayang Karaniwang Rate",
  "Illustrative rate": "Halimbawang rate",
  "Estimated Bill": "Tinatayang Bill",
  "Before final statement": "Bago ang pinal na statement",
  "Rate Category": "Kategorya ng Rate",
  "Account tariff": "Taripa ng account",
  "Sample Charge Breakdown": "Halimbawang Detalye ng mga Singil",
  "Charge Category": "Kategorya ng Singil",
  "Description": "Paglalarawan",
  "Estimated Amount": "Tinatayang Halaga",
  "Generation": "Paglikha",
  "Cost of electricity generation": "Gastos sa paglikha ng kuryente",
  "Transmission": "Transmisyon",
  "Delivery through transmission network": "Paghahatid sa transmission network",
  "Distribution": "Distribusyon",
  "Local distribution and service": "Lokal na distribusyon at serbisyo",
  "Applicable taxes and adjustments": "Mga naaangkop na buwis at pagbabago",
  "Estimated bill": "Tinatayang bill",
  "Rates and amounts shown are sample UI data only. Refer to your official MERALCO bill for actual rates.": "Halimbawa lamang ang mga rate at halagang ipinapakita. Tingnan ang opisyal mong MERALCO bill para sa aktuwal na rate.",
  "Alerts & notifications": "Mga Alerto at Abiso",
  "Recent updates about your electricity account.": "Mga pinakabagong update tungkol sa iyong account sa kuryente.",
  "Mark all as read": "Markahang nabasa lahat",
  "Recent Activity": "Kamakailang Aktibidad",
  "Account settings": "Mga Setting ng Account",
  "Personal Information": "Personal na Impormasyon",
  "Service Details": "Detalye ng Serbisyo",
  "Security": "Seguridad",
  "Preferences": "Mga Kagustuhan",
  "First Name": "Pangalan",
  "Last Name": "Apelyido",
  "Email Address": "Email Address",
  "Mobile Number": "Numero ng Mobile",
  "Save Changes": "I-save ang mga Pagbabago",
  "We're here to help you manage your electricity.": "Narito kami para tulungan kang pamahalaan ang konsumo ng kuryente.",
  "Frequently Asked Questions": "Mga Madalas Itanong",
  "How is my bill estimated?": "Paano tinatantiya ang bill ko?",
  "Your estimate uses recent consumption and sample rates. Your official bill is the final reference.": "Ginagamit sa tantiya ang kamakailang konsumo at mga halimbawang rate. Ang opisyal mong bill ang pinal na batayan.",
  "How do I monitor a device?": "Paano ko susubaybayan ang isang device?",
  "Open Device Monitor to review connected appliance usage.": "Buksan ang Mga Device para tingnan ang konsumo ng mga nakakonektang appliance.",
  "Contact Support": "Makipag-ugnayan sa Suporta",
  "Need help with your account?": "Kailangan mo ba ng tulong sa account?",
  "General Contact Information": "Pangkalahatang Impormasyon sa Pakikipag-ugnayan",
  "Your feedback means a lot to us": "Mahalaga sa amin ang iyong feedback.",
  "Hotline": "Hotline",
  "Dial (02) 16211": "Tumawag sa (02) 16211",
  "Email": "Email",
  "Mobile": "Mobile",
  "Dial (02) 16211 on Mobile": "Tumawag sa (02) 16211 gamit ang mobile",
  "Facebook": "Facebook",
  "@meralco": "@meralco",
  "Twitter": "Twitter",
  "Meralco": "Meralco",
  "YouTube": "YouTube",
  "Meralco YouTube": "Meralco YouTube",
  "Instagram": "Instagram",
  "Meralco Messenger": "Meralco Messenger",
  "Message us": "Magpadala ng mensahe",
  "System Information": "Impormasyon ng System",
  "Application": "Aplikasyon",
  "SmartWatts UI Demo": "Demo ng SmartWatts UI",
  "Version": "Bersyon",
  "Operational": "Gumagana",
  "About the SmartWatts team": "Tungkol sa team ng SmartWatts",
  "A clearer way to understand everyday electricity use.": "Mas malinaw na paraan para maunawaan ang pang-araw-araw na konsumo ng kuryente.",
  "MONITOR. SAVE. SMARTER.": "SUBAYBAYAN. MAGTIPID. MAS MATALINO.",
  "Energy insights made easier.": "Mas madaling maunawaan ang enerhiya.",
  "SmartWatts is a dashboard concept for helping households monitor electricity use, explore usage patterns, and stay on top of bills.": "Konsepto ang SmartWatts dashboard para matulungan ang mga pamilya na subaybayan ang konsumo, tingnan ang mga pattern, at pamahalaan ang mga bill.",
  "Our purpose": "Layunin namin",
  "Make usage easier to understand": "Gawing mas madaling maunawaan ang konsumo",
  "Bring consumption, device breakdowns, and billing estimates together in one approachable place.": "Pagsamahin ang konsumo, detalye ng mga device, at tantiya ng bill sa iisang madaling gamiting lugar.",
  "Our approach": "Paraan namin",
  "Turn data into useful insights": "Gawing kapaki-pakinabang na kaalaman ang datos",
  "Present sample energy information in clear charts and summaries that help people make informed decisions.": "Ipakita ang halimbawang datos ng enerhiya sa malinaw na chart at buod para makatulong sa matalinong pagpapasya.",
  "Our team": "Ang aming team",
  "Project team": "Team ng proyekto",
  "Team member names and roles are omitted until verified details are available.": "Hindi muna ipinapakita ang mga pangalan at tungkulin ng team hangga't walang beripikadong detalye.",
  "This demo uses sample account and usage data. It is not affiliated with or an official service of MERALCO.": "Gumagamit ang demo na ito ng halimbawang account at datos ng konsumo. Hindi ito opisyal na serbisyo ng MERALCO.",
  "Export": "I-export",
  "English": "English",
  "Tagalog": "Tagalog",
  "Language": "Wika",
  "Interface language": "Wika ng interface",
  "Usage time range": "Panahon ng konsumo",
  "Switch to dark mode": "Lumipat sa dark mode",
  "Switch to light mode": "Lumipat sa light mode",
  "Today": "Ngayong Araw",
  "This Week": "Ngayong Linggo",
  "Last 24 hours": "Nakaraang 24 oras",
  "Quarterly": "Kada Tatlong Buwan",
  "Yearly": "Taunan",
  "This Quarter": "Ngayong Quarter",
  "Usage (kW)": "Konsumo (kW)",
  "Consumption (kWh)": "Konsumo (kWh)",
  "kWh": "kWh",
  "kW": "kW",
  "XP": "XP",
  "points": "puntos",
  "pts": "puntos",
  "day streak": "araw na sunod-sunod",
  "to level": "bago ang level",
  "Level": "Antas",
  "Spark": "Kislap",
  "Bulb Buddy": "Kaibigang Bumbilya",
  "Watt Watcher": "Tagasubaybay ng Watt",
  "Power Saver": "Matipid sa Kuryente",
  "Grid Guardian": "Tagapangalaga ng Grid",
  "Energy Hero": "Bayani ng Enerhiya",
  "Volt Legend": "Alamat ng Volt",
  "Small changes.": "Maliliit na pagbabago.",
  "Big savings.": "Malaking tipid.",
  "Watts points": "Puntos ng Watts",
  "Energy saving progress": "Progreso sa pagtitipid ng enerhiya",
  "All quests →": "Lahat ng misyon →",
  "Day streak": "Sunod-sunod na araw",
  "Quests done": "Mga natapos na misyon",
  "⚡ NEXT QUEST": "⚡ SUSUNOD NA MISYON",
  "🎉 QUESTS CLEARED": "🎉 TAPOS NA ANG MGA MISYON",
  "Perfect run!": "Perpektong takbo!",
  "Come back tomorrow for fresh quests and keep your streak alive.": "Bumalik bukas para sa mga bagong misyon at ipagpatuloy ang streak mo.",
  "See my badges": "Tingnan ang mga badge ko",
  "All quests done. You're glowing!": "Tapos na ang lahat ng misyon. Nagniningning ka!",
  "All quests cleared!": "Tapos na ang lahat ng misyon!",
  "Power down for an hour": "Patayin ang di-ginagamit nang isang oras",
  "Switch off unused lights and appliances for one hour.": "Patayin ang di-ginagamit na ilaw at appliance nang isang oras.",
  "Set the AC to 25°C": "Itakda sa 25°C ang aircon",
  "A slightly warmer setting can trim cooling energy.": "Makakatipid sa pagpapalamig ang bahagyang mas mataas na setting.",
  "Chargers and TVs sip power even when idle.": "Kumokonsumo pa rin ng kuryente ang charger at TV kahit hindi ginagamit.",
  "Open the curtains and keep the lights off.": "Buksan ang kurtina at patayin ang ilaw.",
  "Wash a full load": "Maglaba nang puno ang makina",
  "Fewer, fuller loads use less energy overall.": "Mas kaunting laba na puno ang makina ay mas matipid sa enerhiya.",
  "Set a realistic goal": "Magtakda ng makatotohanang layunin",
  "Let's go!": "Kaya natin ito!",
  "Quest complete!": "Tapos na ang misyon!",
  "Monthly energy target updated.": "Na-update ang buwanang target sa enerhiya.",
  "Choose a monthly target from 50 to 2,000 kWh.": "Pumili ng buwanang target mula 50 hanggang 2,000 kWh.",
  "Target updated for this session; browser storage is unavailable.": "Na-update ang target para sa session na ito; hindi magamit ang browser storage.",
  "Account changes saved in this demo.": "Na-save ang mga pagbabago sa account sa demo na ito.",
  "Demo export prepared. Connect a backend to download real records.": "Inihanda ang demo export. Ikonekta ang backend para makapag-download ng totoong tala.",
  "Sample statement download is not connected yet.": "Hindi pa nakakonekta ang pag-download ng halimbawang statement.",
  "Payment is a demo action. No transaction was made.": "Demo action lamang ang pagbabayad. Walang naganap na transaksyon.",
  "Device pairing is ready for backend integration.": "Handa na ang pagpapares ng device para ikonekta sa backend.",
  "Device details opened in demo mode.": "Binuksan ang detalye ng device sa demo mode.",
  "All notifications marked as read.": "Minarkahang nabasa ang lahat ng abiso.",
  "You have already completed today's sample challenge.": "Natapos mo na ang hamon para sa araw na ito.",
  "5 quests left. Let's go!": "5 misyon pa. Kaya natin ito!",
  "4 quests left. Let's go!": "4 na misyon pa. Kaya natin ito!",
  "3 quests left. Let's go!": "3 misyon pa. Kaya natin ito!",
  "2 quests left. Let's go!": "2 misyon pa. Kaya natin ito!",
  "1 quest left. Let's go!": "1 misyon pa. Kaya natin ito!",
  "LEVEL": "ANTAS",
  "NEXT QUEST": "SUSUNOD NA MISYON",
  "QUESTS CLEARED": "TAPOS NA ANG MGA MISYON",
  "Experience to next level": "Karanasan bago ang susunod na antas",
  "XP to level": "XP bago ang antas",
  "All rights reserved.": "Nakalaan ang lahat ng karapatan.",
  "Data from MERALCO": "Datos mula sa MERALCO",
  "Need Help?": "Kailangan ng Tulong?",
  "Contact MERALCO support for any assistance.": "Makipag-ugnayan sa suporta ng MERALCO para sa tulong.",
  "Monitor. Save. Smarter.": "Subaybayan. Magtipid. Mas matalino.",
  "SmartWatts": "SmartWatts",
  "SmartWatts | Energy Dashboard": "SmartWatts | Dashboard ng Enerhiya",
  "Activity": "Aktibidad",
  "Meter": "Metro",
  "Open": "Bukas",
  "Close chat": "Isara ang chat",
  "Message": "Mensahe",
  "Day": "Araw",
  "Mon": "Lun",
  "Tue": "Mar",
  "Wed": "Miy",
  "Thu": "Huw",
  "Fri": "Biy",
  "Sat": "Sab",
  "Sun": "Lin",
  "Jan": "Ene",
  "Feb": "Peb",
  "Mar": "Mar",
  "Apr": "Abr",
  "May": "May",
  "Jun": "Hun",
  "Jul": "Hul",
  "Aug": "Ago",
  "Sep": "Set",
  "Oct": "Okt",
  "Nov": "Nob",
  "Dec": "Dis",
  "This is a demo action.": "Demo action lamang ito.",
  "A sample daily usage profile — SmartWatts does not connect to meters.": "Isang halimbawang pang-araw-araw na profile ng konsumo — hindi kumokonekta ang SmartWatts sa mga metro.",
  "Register appliances and estimate their energy use.": "Magrehistro ng mga appliance at tantiyahin ang konsumo sa enerhiya.",
  "Review your estimated bill and payment details.": "Suriin ang iyong tinatayang bill at mga detalye ng pagbabayad.",
  "Understand your electricity rate and charges.": "Unawain ang rate at mga singil sa iyong kuryente.",
  "Stay updated with usage alerts and account activity.": "Manatiling updated sa mga alerto sa konsumo at aktibidad ng account.",
  "Manage your profile and account preferences.": "Pamahalaan ang iyong profile at mga kagustuhan sa account.",
  "Meet the people and purpose behind SmartWatts.": "Kilalanin ang mga tao at layunin sa likod ng SmartWatts.",
  "No meter is connected. Add your official bills to track real consumption.": "Walang nakakonektang metro. Idagdag ang iyong mga opisyal na bill upang masubaybayan ang totoong konsumo.",
  "Add a bill": "Magdagdag ng bill",
  "Register appliances and schedules to see where your electricity likely goes.": "Magrehistro ng mga appliance at iskedyul upang makita kung saan napupunta ang iyong kuryente.",
  "Try schedule changes in the savings simulator.": "Subukan ang mga pagbabago sa iskedyul sa simulator ng pagtitipid.",
  "Open simulator": "Buksan ang simulator",
  "Total Amount": "Kabuuang Halaga",
  "Total": "Kabuuan",
  "How to pay your utility": "Paano magbayad sa iyong utility",
  "Can my landlord see my appliances?": "Maaari bang makita ng aking kasero ang aking mga appliance?",
  "No. Appliances, schedules, savings plans, and AI chats are private to your account, even when you rent through SmartWatts Rentals.": "Hindi. Ang mga appliance, iskedyul, plano sa pagtitipid, at usapan sa AI ay pribado sa iyong account, kahit nangungupahan ka sa SmartWatts Rentals.",
  "Search the official list of Meralco Business Centers, see published branch contacts, and get directions.": "Maghanap sa opisyal na talaan ng mga Meralco Business Center, tingnan ang mga contact ng sangay, at kumuha ng direksiyon.",
  "Usage history downloaded successfully.": "Matagumpay na na-download ang kasaysayan ng konsumo.",
  "Unable to download usage history. Please try again.": "Hindi ma-download ang kasaysayan ng konsumo. Pakisubukan muli.",
  "Analytics report exported successfully.": "Matagumpay na na-export ang ulat ng analytics.",
  "Unable to export analytics report. Please try again.": "Hindi ma-export ang ulat ng analytics. Pakisubukan muli.",
  "Exporting…": "Nag-e-export…",
  "Export Report": "I-export ang Ulat",
  "Export CSV": "I-export ang CSV",
  "Recent Usage Records": "Mga Kamakailang Talaan ng Konsumo",
  "Recent Usage Record": "Kamakailang Talaan ng Konsumo",
  "Statement": "Statement",
  "Display Name": "Pangalan na Ipapakita",
  "No notifications yet.": "Wala pang mga abiso.",
  "Appliance Saved": "Na-save ang Appliance",
  "Electricity Bill Saved": "Na-save ang Bill sa Kuryente",
  "Savings Plan Saved": "Na-save ang Plano sa Pagtitipid",
  "Energy Goal Updated": "Na-update ang Layunin sa Enerhiya",
  "Usage Record Downloaded": "Na-download ang Talaan ng Konsumo",
  "Usage History Exported": "Na-export ang Kasaysayan ng Konsumo",
  "Analytics Report Ready": "Handa na ang Ulat ng Analytics",
  "Mark all as read": "Markahan lahat bilang nabasa",
  "Recent Activity": "Kamakailang Aktibidad",
  "Alerts & notifications": "Mga Alerto at Abiso",
  "Rolex Esto": "Rolex Esto",
  "Lead Developer / Engineering": "Pangunahing Developer / Inhinyero",
  "Download": "I-download",
};

const originalText = new WeakMap();
const originalAttributes = new WeakMap();

const isLanguageCode = (language) => typeof language === "string" && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language);

export function getLanguage() {
  try {
    const language = localStorage.getItem(LANGUAGE_KEY);
    return isLanguageCode(language) ? language : "en";
  } catch {
    return "en";
  }
}

export async function loadSupportedLanguages() {
  const languages = await fetchProviderLanguages();
  // Locally supported languages are always offered, with their own display names.
  const uniqueLanguages = [...new Map([...languages, ...DEFAULT_LANGUAGES].map((language) => [language.code, language])).values()];
  if (!uniqueLanguages.some(({ code }) => code === "en")) {
    throw new Error("Google Cloud Translation did not include English in its language list.");
  }
  supportedLanguages = uniqueLanguages.sort((first, second) => {
    if (first.code === "en") return -1;
    if (second.code === "en") return 1;
    return first.name.localeCompare(second.name);
  });
  return supportedLanguages;
}

export function getSupportedLanguages() {
  return supportedLanguages;
}

export function setLanguage(language) {
  if (!isLanguageCode(language) || !supportedLanguages.some(({ code }) => code === language)) {
    window.dispatchEvent(new CustomEvent("smartwatts-translation-error", {
      detail: "The selected language is not available from Google Cloud Translation.",
    }));
    return;
  }
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // Keep the language change active for this page session.
  }
  window.dispatchEvent(new CustomEvent("smartwatts-language-change", { detail: language }));
}

export function translateText(value, language = getLanguage()) {
  const leading = value.match(/^\s*/)[0];
  const trailing = value.match(/\s*$/)[0];
  const content = value.trim();
  if (!content || language === "en") return value;
  const cached = translatedCache.get(`${language}\u0000${content}`);
  if (cached) return `${leading}${cached}${trailing}`;
  if (language !== "tl") {
    const local = STATIC_DICTIONARIES[language]?.[content];
    return local ? `${leading}${local}${trailing}` : value;
  }
  let translated = translations[content];

  if (!translated) {
    const points = content.match(/^(\d+) points$/);
    const streak = content.match(/^(\d+) day streak$/);
    const shortDate = content.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?:, (\d{4}))?$/);
    const dateRange = content.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) – (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})$/);
    const level = content.match(/^Level (\d+) · (.+) · (\d+) XP to level (\d+)$/);
    const claim = content.match(/^Claim \+(\d+)$/);
    const xp = content.match(/^\+(\d+) XP$/);
    const badgeCount = content.match(/^(\d+)\/(\d+) earned$/);
    const questCount = content.match(/^(\d+) of (\d+) quests completed$/);
    const completed = content.match(/^Quest complete! \+(\d+) XP\.$/);
    const unlocked = content.match(/^(\d+) day streak$/);
    const overTarget = content.match(/^You're ([\d,.]+) kWh over your monthly target\. Reduce usage to get back on track\.$/);
    const underTarget = content.match(/^You have ([\d,.]+) kWh left before reaching your monthly target\.$/);
    const levelOnly = content.match(/^Level (\d+) · (.+)$/);
    const xpToLevel = content.match(/^(\d+) XP to level (\d+)$/);
    const dayLabel = content.match(/^Day (\d+)$/);
    const levelChip = content.match(/^Level (\d+)$/);
    const gameLevel = content.match(/^LEVEL (\d+) · (.+)$/);
    const greeting = content.match(/^Good (morning|afternoon|evening), (.+)!$/);
    const footer = content.match(/^© (\d{4}) SmartWatts\. All rights reserved\.$/);

    const dateMonths = {
      Jan: "Enero",
      Feb: "Pebrero",
      Mar: "Marso",
      Apr: "Abril",
      May: "Mayo",
      Jun: "Hunyo",
      Jul: "Hulyo",
      Aug: "Agosto",
      Sep: "Setyembre",
      Oct: "Oktubre",
      Nov: "Nobyembre",
      Dec: "Disyembre",
    };

    if (points) translated = `${points[1]} puntos`;
    else if (shortDate) translated = `${dateMonths[shortDate[1]]} ${shortDate[2]}${shortDate[3] ? `, ${shortDate[3]}` : ""}`;
    else if (dateRange) translated = `${dateMonths[dateRange[1]]} ${dateRange[2]} – ${dateMonths[dateRange[3]]} ${dateRange[4]}, ${dateRange[5]}`;
    else if (streak) translated = `${streak[1]} araw na sunod-sunod`;
    else if (level) translated = `Antas ${level[1]} · ${translations[level[2]] || level[2]} · ${level[3]} XP bago ang level ${level[4]}`;
    else if (claim) translated = `Kunin +${claim[1]}`;
    else if (xp) translated = `+${xp[1]} XP`;
    else if (badgeCount) translated = `${badgeCount[1]}/${badgeCount[2]} nakuha`;
    else if (questCount) translated = `${questCount[1]} sa ${questCount[2]} misyon ang natapos`;
    else if (completed) translated = `Tapos na ang misyon! +${completed[1]} XP.`;
    else if (unlocked) translated = `${unlocked[1]} araw na sunod-sunod`;
    else if (overTarget) translated = `Lampas ka nang ${overTarget[1]} kWh sa buwanang target. Bawasan ang konsumo para makabalik sa target.`;
    else if (underTarget) translated = `${underTarget[1]} kWh pa bago maabot ang buwanang target.`;
    else if (levelOnly) translated = `Antas ${levelOnly[1]} · ${translations[levelOnly[2]] || levelOnly[2]}`;
    else if (xpToLevel) translated = `${xpToLevel[1]} XP bago ang antas ${xpToLevel[2]}`;
    else if (dayLabel) translated = `Araw ${dayLabel[1]}`;
    else if (levelChip) translated = `Antas ${levelChip[1]}`;
    else if (gameLevel) {
      const title = Object.entries(translations).find(([english]) => english.toUpperCase() === gameLevel[2])?.[1] || gameLevel[2];
      translated = `ANTAS ${gameLevel[1]} · ${title.toUpperCase()}`;
    } else if (greeting) {
      const g = greeting[1] === "morning" ? "Magandang umaga" : greeting[1] === "afternoon" ? "Magandang hapon" : "Magandang gabi";
      translated = `${g}, ${greeting[2]}!`;
    } else if (footer) translated = `© ${footer[1]} SmartWatts. Nakalaan ang lahat ng karapatan.`;
  }

  return translated ? `${leading}${translated}${trailing}` : value;
}

function queueTranslation(language, revision, original, apply) {
  const batchKey = `${language}:${revision}`;
  let batch = queuedTranslations.get(batchKey);
  if (!batch) {
    batch = new Map();
    queuedTranslations.set(batchKey, batch);
  }
  const callbacks = batch.get(original) || [];
  callbacks.push(apply);
  batch.set(original, callbacks);

  if (translationFlushTimer === null) {
    translationFlushTimer = window.setTimeout(() => {
      translationFlushTimer = null;
      void flushQueuedTranslations();
    }, 0);
  }
}

async function flushQueuedTranslations() {
  const batches = [...queuedTranslations.entries()];
  queuedTranslations.clear();

  for (const [batchKey, entries] of batches) {
    const separatorIndex = batchKey.lastIndexOf(":");
    const language = batchKey.slice(0, separatorIndex);
    const revision = Number(batchKey.slice(separatorIndex + 1));
    const uniqueEntries = [...entries.entries()];
    let chunk = [];
    let chunkLength = 0;

    const flushChunk = async () => {
      if (!chunk.length) return;
      const currentChunk = chunk;
      chunk = [];
      chunkLength = 0;
      const originals = currentChunk.map(([original]) => original);
      try {
        const results = await translateTexts(language, originals);
        results.forEach((result, index) => {
          const [original, callbacks] = currentChunk[index];
          translatedCache.set(`${language}\u0000${original}`, result);
          if (activeLanguage === language && translationRevision === revision) {
            callbacks.forEach((apply) => apply(result));
          }
        });
        if (activeLanguage === language && translationRevision === revision) {
          window.dispatchEvent(new CustomEvent("smartwatts-translation-complete", { detail: language }));
        }
      } catch (error) {
        if (activeLanguage === language && translationRevision === revision) {
          const message = error instanceof Error ? error.message : "Translation request failed.";
          window.dispatchEvent(new CustomEvent("smartwatts-translation-error", { detail: message }));
        }
      }
    };

    for (const entry of uniqueEntries) {
      const textLength = entry[0].length;
      if (chunk.length >= 80 || chunkLength + textLength > 22000) {
        await flushChunk();
      }
      chunk.push(entry);
      chunkLength += textLength;
    }
    await flushChunk();
  }
}

export function translateTree(root, language = getLanguage()) {
  if (activeLanguage !== language) {
    activeLanguage = language;
    translationRevision += 1;
  }
  const revision = translationRevision;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest("#chat-root, script, style, [translate='no']")) continue;
    if (!originalText.has(node)) originalText.set(node, node.nodeValue);
    const original = originalText.get(node).trim();
    const localValue = translateText(originalText.get(node), language);
    node.nodeValue = localValue;
    const cached = translatedCache.get(`${language}\u0000${original}`);
    if (needsRemote(language, original, localValue)) {
      if (cached) node.nodeValue = node.nodeValue.replace(original, cached);
      else queueTranslation(language, revision, original, (result) => {
        if (node.isConnected) node.nodeValue = `${node.nodeValue.match(/^\s*/)[0]}${result}${node.nodeValue.match(/\s*$/)[0]}`;
      });
    }
  }

  const translatedAttributes = ["aria-label", "placeholder", "title", "value"];
  root.querySelectorAll("*").forEach((element) => {
    if (element.closest("#chat-root, script, style, [translate='no']")) return;
    let originals = originalAttributes.get(element);
    if (!originals) {
      originals = new Map();
      originalAttributes.set(element, originals);
    }
    translatedAttributes.forEach((attribute) => {
      if (!element.hasAttribute(attribute)) return;
      // A hidden input's value attribute IS its data (e.g. labelType, source). Rewriting the
      // attribute resets the value, so never translate it.
      if (attribute === "value" && element.matches?.('input[type="hidden"]')) return;
      const isDynamicThemeLabel = element.id === "themeToggle" && (attribute === "aria-label" || attribute === "title");
      if (!isDynamicThemeLabel && !originals.has(attribute)) originals.set(attribute, element.getAttribute(attribute));
      const original = isDynamicThemeLabel ? element.getAttribute(attribute) : originals.get(attribute);
      const translated = translateText(original, language);
      element.setAttribute(attribute, translated);
      if (needsRemote(language, original?.trim(), translated)) {
        const cached = translatedCache.get(`${language}\u0000${original.trim()}`);
        if (cached) element.setAttribute(attribute, `${original.match(/^\s*/)[0]}${cached}${original.match(/\s*$/)[0]}`);
        else queueTranslation(language, revision, original.trim(), (result) => {
          if (element.isConnected) element.setAttribute(attribute, `${original.match(/^\s*/)[0]}${result}${original.match(/\s*$/)[0]}`);
        });
      }
    });
  });
}
