/**
 * Meralco Business Centers — transcribed from the official directory.
 *
 * Source: https://www.meralco.com.ph/help/meralco-business-centers
 * Source page states: "52 centers in 7 areas. Updated 23 October 2026."
 * Transcribed/verified by SmartWatts on 2026-11-12.
 *
 * Rules (do not break when refreshing — see docs/BUSINESS_CENTERS.md):
 * - Only values published on the source page. Nothing is inferred.
 * - Operating hours are NOT published on the source page, so none are stored.
 * - `phone` is the per-branch "Call" number exactly as shown on the page; null when the page shows no call button.
 * - `coordinates` only when the page publishes them (San Miguel directions link). The page itself
 *   says its map pins are approximate. All other centers have null coordinates.
 * - `googlePlaceId` comes from the page's "Open in Google Maps" link.
 */

export interface BusinessCenter {
  id: string;
  name: string;
  area: string;
  locality: string;
  address: string;
  phone: string | null;
  googlePlaceId: string | null;
  coordinates: { lat: number; lng: number } | null;
  email: string | null;
}

export const BUSINESS_CENTERS_SOURCE = {
  url: "https://www.meralco.com.ph/help/meralco-business-centers",
  sourceUpdated: "2026-10-23",
  lastVerified: "2026-11-12",
  publishedCount: 52,
};

export const BUSINESS_CENTERS: BusinessCenter[] = [
  {
    "id": "batangas-branch",
    "name": "Meralco Business Center - Batangas Branch",
    "area": "Batangas",
    "locality": "Batangas City, Batangas",
    "address": "Doña Manuela, M. Pastor Ave, Batangas City, 4200 Batangas, Philippines",
    "phone": "1622 2847",
    "googlePlaceId": "ChIJy3S8WkgFvTMR-T9Pvv-Orgg",
    "coordinates": null,
    "email": null
  },
  {
    "id": "balagtas-branch",
    "name": "Meralco Business Center - Balagtas Branch",
    "area": "Bulacan",
    "locality": "Balagtas, Bulacan",
    "address": "MacArthur Hwy, Balagtas, 3016 Bulacan, Philippines",
    "phone": "1622 2548",
    "googlePlaceId": "ChIJUfVdYi6tlzMRjm8N0aShmWE",
    "coordinates": null,
    "email": null
  },
  {
    "id": "baliwag-branch",
    "name": "Meralco Business Center - Baliwag Branch",
    "area": "Bulacan",
    "locality": "Baliuag, Bulacan",
    "address": "J.P. Rizal St, Baliwag, 3006 Bulacan, Philippines",
    "phone": "1622 2594",
    "googlePlaceId": "ChIJ60WTzy9VljMREealW4slvqw",
    "coordinates": null,
    "email": null
  },
  {
    "id": "malolos-branch",
    "name": "Meralco Business Center - Malolos Branch",
    "area": "Bulacan",
    "locality": "Malolos City, Bulacan",
    "address": "4 Pariancillo St, Malolos, 3000 Bulacan, Philippines",
    "phone": "1622 6567",
    "googlePlaceId": "ChIJ5fGLsixSljMR8xWZLiLpIFg",
    "coordinates": null,
    "email": null
  },
  {
    "id": "marilao-branch",
    "name": "Meralco Business Center - Marilao Branch",
    "area": "Bulacan",
    "locality": "Marilao, Bulacan",
    "address": "MacArthur Hwy, Marilao, 3019 Bulacan, Philippines",
    "phone": "1622 6745",
    "googlePlaceId": "ChIJ9ej1dmKylzMRePNFDySExfk",
    "coordinates": null,
    "email": null
  },
  {
    "id": "san-jose-del-monte-extension-office",
    "name": "Meralco Business Center - San Jose Del Monte Extension Office",
    "area": "Bulacan",
    "locality": "San Jose del Monte City, Bulacan",
    "address": "Quirino Hwy, San Jose del Monte, 3023 Bulacan, Philippines",
    "phone": "1622 7573",
    "googlePlaceId": "ChIJQ6lvL4mvlzMRiD4x8jwtqvc",
    "coordinates": null,
    "email": null
  },
  {
    "id": "san-miguel-branch",
    "name": "Meralco Business Center - San Miguel Branch",
    "area": "Bulacan",
    "locality": "San Miguel, Bulacan",
    "address": "272 Victor St, San Miguel, Bulacan",
    "phone": "1622 7645",
    "googlePlaceId": null,
    "coordinates": {
      "lat": 15.145878,
      "lng": 120.972198
    },
    "email": null
  },
  {
    "id": "sta-maria-branch",
    "name": "Meralco Business Center - Sta. Maria Branch",
    "area": "Bulacan",
    "locality": "Santa Maria, Bulacan",
    "address": "644 Gov Fortunato Halili Ave, Santa Maria, 3022 Bulacan, Philippines",
    "phone": "1622 6274",
    "googlePlaceId": "ChIJPSKxv7OtlzMRk4QHaAzu_cE",
    "coordinates": null,
    "email": null
  },
  {
    "id": "bacoor-branch",
    "name": "Meralco Business Center - Bacoor Branch",
    "area": "Cavite",
    "locality": "Bacoor City, Cavite",
    "address": "Meadowood Ave, cor Emilio Aguinaldo Hwy, Bacoor, 4102 Cavite, Philippines",
    "phone": "1622 2227",
    "googlePlaceId": "ChIJ-aJbG3rSlzMRC8LO32n9nq4",
    "coordinates": null,
    "email": null
  },
  {
    "id": "dasmari-as-branch",
    "name": "Meralco Business Center - Dasmariñas Branch",
    "area": "Cavite",
    "locality": "Dasmariñas City, Cavite",
    "address": "Dasmariñas, 4114 Cavite, Philippines",
    "phone": "1622 3762",
    "googlePlaceId": "ChIJKbce6vnUlzMRzVL6VBg1oX4",
    "coordinates": null,
    "email": null
  },
  {
    "id": "gen-mariano-alvarez-branch",
    "name": "Meralco Business Center - Gen. Mariano Alvarez Branch",
    "area": "Cavite",
    "locality": "General Mariano Alvarez, Cavite",
    "address": "Units 204 & 205, 2F, WJL Bldg, Juanito R. Remulla Sr. Road, San Gabriel, General Mariano Alvarez, 4117 Cavite, Philippines",
    "phone": "1622 3462",
    "googlePlaceId": "ChIJHQhGVrjXlzMRDaKGmmpmAVc",
    "coordinates": null,
    "email": null
  },
  {
    "id": "rosario-branch",
    "name": "Meralco Business Center - Rosario Branch",
    "area": "Cavite",
    "locality": "Rosario, Cavite",
    "address": "Gen. Trias Drive, Rosario, 4106 Cavite, Philippines",
    "phone": "1622 7746",
    "googlePlaceId": "ChIJVVVVDPAsljMRg0ZdcsrFg1A",
    "coordinates": null,
    "email": null
  },
  {
    "id": "tagaytay-branch",
    "name": "Meralco Business Center - Tagaytay Branch",
    "area": "Cavite",
    "locality": "Tagaytay City, Cavite",
    "address": "Gen. Aguinaldo Highway, Tagaytay City, 4120 Cavite, Philippines",
    "phone": "1622 8489",
    "googlePlaceId": "ChIJ14suxqB3vTMRtQCEiyhMQe4",
    "coordinates": null,
    "email": null
  },
  {
    "id": "trece-martires-city",
    "name": "Meralco Business Center - Trece Martires City",
    "area": "Cavite",
    "locality": "Trece Martires City, Cavite",
    "address": "7VJC+9H6, Juanito R. Remulla Sr. Road, San Agustin, Trece Martires City, 4109 Cavite, Philippines",
    "phone": "1622 8739",
    "googlePlaceId": "ChIJ8S5LXgCBvTMRTr2ZBMMlIfU",
    "coordinates": null,
    "email": null
  },
  {
    "id": "calamba-branch",
    "name": "Meralco Business Center - Calamba Branch",
    "area": "Laguna",
    "locality": "Calamba City, Laguna",
    "address": "San Cristobal Bridge, Real, Calamba, 4027 Laguna, Philippines",
    "phone": "1622 2562",
    "googlePlaceId": "ChIJvfWBs85jvTMRod2ppV6wdPI",
    "coordinates": null,
    "email": null
  },
  {
    "id": "los-ba-os-branch",
    "name": "Meralco Business Center - Los Baños Branch",
    "area": "Laguna",
    "locality": "Los Baños, Laguna",
    "address": "Olivarez Plaza, National Highway, Batong Malake, Los Baños, 4030 Laguna, Philippines",
    "phone": "1622 5672",
    "googlePlaceId": "ChIJKzrCQ9xgvTMRYfA2XYVlsmM",
    "coordinates": null,
    "email": "eebalberona@meralco.com.ph"
  },
  {
    "id": "san-pablo-branch",
    "name": "Meralco Business Center - San Pablo Branch",
    "area": "Laguna",
    "locality": "San Pablo City, Laguna",
    "address": "28XR+JW, San Pablo City, 4000 Laguna, Philippines",
    "phone": "1622 7756",
    "googlePlaceId": "ChIJrb-2KVtDvTMROhHJEsIDXO8",
    "coordinates": null,
    "email": null
  },
  {
    "id": "san-pedro-branch",
    "name": "Meralco Business Center - San Pedro Branch",
    "area": "Laguna",
    "locality": "San Pedro City, Laguna",
    "address": "National Highway, Brgy San Antonio, San Pedro, 4023 Laguna, Philippines",
    "phone": "1622 7733",
    "googlePlaceId": "ChIJV5fyT-TZlzMR6Efn0Iapps4",
    "coordinates": null,
    "email": null
  },
  {
    "id": "sta-cruz-branch",
    "name": "Meralco Business Center - Sta. Cruz Branch",
    "area": "Laguna",
    "locality": "Santa Cruz, Laguna",
    "address": "Pedro Guevarra St, Sta. Cruz, 4009 Laguna, Philippines",
    "phone": "1622 7789",
    "googlePlaceId": "ChIJXbenjm7jlzMRRONWiJ-MvgM",
    "coordinates": null,
    "email": null
  },
  {
    "id": "sta-rosa-branch",
    "name": "Meralco Business Center - Sta. Rosa Branch",
    "area": "Laguna",
    "locality": "Santa Rosa City, Laguna",
    "address": "San Cristobal Bridge, Bo. Dita, City of Santa Rosa, 4026 Laguna, Philippines",
    "phone": "1622 7767",
    "googlePlaceId": "ChIJlZWCWWbYlzMRW9zBT8SXYAE",
    "coordinates": null,
    "email": null
  },
  {
    "id": "laguna-central-branch",
    "name": "Meralco Business Center - Laguna Central Branch",
    "area": "Laguna",
    "locality": "Santa Rosa City, Laguna",
    "address": "21S Laguna Central Bldg. I, Laguna Blvd. cor. Tagaytay-Balibago Road, City of Santa Rosa, 4026 Laguna, Philippines",
    "phone": null,
    "googlePlaceId": "ChIJTRlt-kZ9vTMRVULBRb0Dv-U",
    "coordinates": null,
    "email": null
  },
  {
    "id": "muntinlupa",
    "name": "Meralco Business Center - Muntinlupa",
    "area": "Metro Manila",
    "locality": "Muntinlupa City, Metro Manila",
    "address": "Prime Street, New Alabang Village, Muntinlupa, Metro Manila",
    "phone": "1622 2522",
    "googlePlaceId": "ChIJy6AgUM7RlzMRiu5RkgJc0X4",
    "coordinates": null,
    "email": null
  },
  {
    "id": "araneta-ali-mall-branch",
    "name": "Meralco Business Center - Araneta (Ali Mall) Branch",
    "area": "Metro Manila",
    "locality": "Quezon City, Metro Manila",
    "address": "Gen. Romulo Ave, Araneta Center, cor P. Tuazon Blvd, Cubao, Quezon City, 1109 Metro Manila, Philippines",
    "phone": "1622 2726",
    "googlePlaceId": "ChIJwcdAtuq3lzMRPsaCnTiD04c",
    "coordinates": null,
    "email": null
  },
  {
    "id": "balintawak-branch",
    "name": "Meralco Business Center - Balintawak Branch",
    "area": "Metro Manila",
    "locality": "Quezon City, Metro Manila",
    "address": "1199 EDSA, near Muñoz, Brgy Balingasa, Quezon City, 1105 Metro Manila, Philippines",
    "phone": "1622 2585",
    "googlePlaceId": "ChIJrxw6IO62lzMRpAoP83H3yYE",
    "coordinates": null,
    "email": null
  },
  {
    "id": "caloocan-branch",
    "name": "Meralco Business Center - Caloocan Branch",
    "area": "Metro Manila",
    "locality": "Caloocan City, Metro Manila",
    "address": "135 Samson Rd, Caloocan, 1400 Metro Manila, Philippines",
    "phone": "1622 2526",
    "googlePlaceId": "ChIJj6HtICy0lzMRlqrJcuicLtI",
    "coordinates": null,
    "email": null
  },
  {
    "id": "camarin-branch",
    "name": "Meralco Business Center - Camarin Branch",
    "area": "Metro Manila",
    "locality": "Caloocan City, Metro Manila",
    "address": "Lots 8 & 9, Block 10, Camarin Rd, Camarin, Caloocan, 1400 Metro Manila, Philippines",
    "phone": "1622 2676",
    "googlePlaceId": "ChIJSSRNFCOwlzMRmT9AYXTCYpQ",
    "coordinates": null,
    "email": null
  },
  {
    "id": "commonwealth-branch",
    "name": "Meralco Business Center - Commonwealth Branch",
    "area": "Metro Manila",
    "locality": "Quezon City, Metro Manila",
    "address": "Capitol Estate 2, Commonwealth Ave, Quezon City, 1126 Metro Manila, Philippines",
    "phone": "1622 2666",
    "googlePlaceId": "ChIJg9bxCwS6lzMRxFTeDgReWWo",
    "coordinates": null,
    "email": null
  },
  {
    "id": "espa-a-branch",
    "name": "Meralco Business Center - España Branch",
    "area": "Metro Manila",
    "locality": "Manila, Metro Manila",
    "address": "2200 España Blvd, cor Josefina, Sampaloc, Manila, 1008 Metro Manila, Philippines",
    "phone": "1622 3776",
    "googlePlaceId": "ChIJQWJ03Rq2lzMR8ND_YIAAXqM",
    "coordinates": null,
    "email": null
  },
  {
    "id": "karuhatan-branch",
    "name": "Meralco Business Center - Karuhatan Branch",
    "area": "Metro Manila",
    "locality": "Valenzuela City, Metro Manila",
    "address": "255 MacArthur Hwy, Valenzuela, 1441 Metro Manila, Philippines",
    "phone": null,
    "googlePlaceId": "ChIJp82Eag-0lzMR0vGCyxqluYc",
    "coordinates": null,
    "email": null
  },
  {
    "id": "las-pi-as-branch",
    "name": "Meralco Business Center - Las Piñas Branch",
    "area": "Metro Manila",
    "locality": "Las Piñas City, Metro Manila",
    "address": "4th floor, Vista Mall, cor Alabang–Zapote Rd, Las Piñas, 1747 Metro Manila, Philippines",
    "phone": "1622 5767",
    "googlePlaceId": "ChIJAbU5wv7NlzMR9F4aZVmviAA",
    "coordinates": null,
    "email": null
  },
  {
    "id": "makati-branch",
    "name": "Meralco Business Center - Makati Branch",
    "area": "Metro Manila",
    "locality": "Makati City, Metro Manila",
    "address": "9851 Kamagong St, cor Ayala Ave Extension, Makati City, 1203 Metro Manila, Philippines",
    "phone": "1622 6584",
    "googlePlaceId": "ChIJYZdBqKDJlzMRG1CYNjrN-rQ",
    "coordinates": null,
    "email": null
  },
  {
    "id": "malabon-branch",
    "name": "Meralco Business Center - Malabon Branch",
    "area": "Metro Manila",
    "locality": "Malabon City, Metro Manila",
    "address": "201 Gen. Luna St, Concepcion, Malabon, 1470 Metro Manila, Philippines",
    "phone": "1622 6566",
    "googlePlaceId": "ChIJwf3w6lC0lzMRtanho87JVjs",
    "coordinates": null,
    "email": null
  },
  {
    "id": "malate-branch",
    "name": "Meralco Business Center - Malate Branch",
    "area": "Metro Manila",
    "locality": "Manila, Metro Manila",
    "address": "957 Escoda St, Malate, Manila, 1000 Metro Manila, Philippines",
    "phone": "1622 6583",
    "googlePlaceId": "ChIJf305dojJlzMRciqH2Ha6HRg",
    "coordinates": null,
    "email": null
  },
  {
    "id": "mandaluyong-branch",
    "name": "Meralco Business Center - Mandaluyong Branch",
    "area": "Metro Manila",
    "locality": "Mandaluyong City, Metro Manila",
    "address": "285 Shaw Blvd, cor M. Yulo St, Mandaluyong City, 1552 Metro Manila, Philippines",
    "phone": "1622 6263",
    "googlePlaceId": "ChIJPQT0zTLIlzMRG3lsLHruSr8",
    "coordinates": null,
    "email": null
  },
  {
    "id": "marikina-branch",
    "name": "Meralco Business Center - Marikina Branch",
    "area": "Metro Manila",
    "locality": "Marikina City, Metro Manila",
    "address": "92 Bayan-Bayanan Ext, Marikina, 1807 Metro Manila, Philippines",
    "phone": "1622 6562",
    "googlePlaceId": "ChIJqyBG5by5lzMRl_e4B95LZNY",
    "coordinates": null,
    "email": null
  },
  {
    "id": "market-market-branch",
    "name": "Meralco Business Center - Market! Market! Branch",
    "area": "Metro Manila",
    "locality": "Taguig City, Metro Manila",
    "address": "Space FMX 24 Fiesta Market! Market! Extension, Taguig, 1634 Metro Manila, Philippines",
    "phone": null,
    "googlePlaceId": "ChIJ39dsqfLIlzMR2fr679tQTiw",
    "coordinates": null,
    "email": null
  },
  {
    "id": "metropoint-mall-branch",
    "name": "Meralco Business Center - Metropoint Mall Branch",
    "area": "Metro Manila",
    "locality": "Pasay City, Metro Manila",
    "address": "Space Nos. 319 & 320, 3F Metropoint Mall, EDSA cor Taft Ave, Pasay City, 1303 Metro Manila, Philippines",
    "phone": null,
    "googlePlaceId": "ChIJcRi2QKLJlzMRxECMizYwgq8",
    "coordinates": null,
    "email": null
  },
  {
    "id": "novaliches-branch",
    "name": "Meralco Business Center - Novaliches Branch",
    "area": "Metro Manila",
    "locality": "Quezon City, Metro Manila",
    "address": "Quirino Highway, cor Forest Hill Dr, Novaliches, Quezon City, 1117 Metro Manila, Philippines",
    "phone": "1622 6682",
    "googlePlaceId": "ChIJlzG-NfuwlzMRvh8UBpNFX-g",
    "coordinates": null,
    "email": null
  },
  {
    "id": "para-aque-branch",
    "name": "Meralco Business Center - Parañaque Branch",
    "area": "Metro Manila",
    "locality": "Parañaque City, Metro Manila",
    "address": "252 Quirino Ave, Parañaque, 1700 Metro Manila, Philippines",
    "phone": "1622 7267",
    "googlePlaceId": "ChIJ2130sKXOlzMRE_G6p70v6TE",
    "coordinates": null,
    "email": null
  },
  {
    "id": "fb-harrison-pasay-branch",
    "name": "Meralco Business Center - FB Harrison Pasay Branch",
    "area": "Metro Manila",
    "locality": "Pasay City, Metro Manila",
    "address": "2238 F.B. Harrison St, Antonio S. Arnaiz Ave, Pasay City, 1300 Metro Manila, Philippines",
    "phone": "1622 7729",
    "googlePlaceId": "ChIJu7BQUWfJlzMR41wo4ksJk_U",
    "coordinates": null,
    "email": null
  },
  {
    "id": "pasig-branch",
    "name": "Meralco Business Center - Pasig Branch",
    "area": "Metro Manila",
    "locality": "Pasig City, Metro Manila",
    "address": "60 Dr. Sixto Antonio Ave, cor Dr. Pilapil St., Pasig, 1600 Metro Manila, Philippines",
    "phone": "1622 7744",
    "googlePlaceId": "ChIJ3Qz2NXjIlzMRKHQHAGhLbPA",
    "coordinates": null,
    "email": null
  },
  {
    "id": "roosevelt-branch",
    "name": "Meralco Business Center - Roosevelt Branch",
    "area": "Metro Manila",
    "locality": "Quezon City, Metro Manila",
    "address": "980 Quezon Ave, Diliman, Quezon City, 1103 Metro Manila, Philippines",
    "phone": "1622 7788",
    "googlePlaceId": "ChIJA0ev_E-2lzMR-pwgM7TxmDw",
    "coordinates": null,
    "email": null
  },
  {
    "id": "taguig-branch",
    "name": "Meralco Business Center - Taguig Branch",
    "area": "Metro Manila",
    "locality": "Taguig City, Metro Manila",
    "address": "35 J.P. Rizal St, Bagong Calzada, Taguig, 1637 Metro Manila, Philippines",
    "phone": "1622 8444",
    "googlePlaceId": "ChIJpeF6YVvJlzMRblu0b-jbx-w",
    "coordinates": null,
    "email": null
  },
  {
    "id": "tutuban-branch",
    "name": "Meralco Business Center - Tutuban Branch",
    "area": "Metro Manila",
    "locality": "Manila, Metro Manila",
    "address": "Tutuban Shopping Complex, Mayhaligue St, cor Antonio Rivera St, Tondo, Manila, 1012 Metro Manila, Philippines",
    "phone": "1622 8826",
    "googlePlaceId": "ChIJH-XhNwjKlzMRsvMSfRQF3bI",
    "coordinates": null,
    "email": null
  },
  {
    "id": "valenzuela-branch",
    "name": "Meralco Business Center - Valenzuela Branch",
    "area": "Metro Manila",
    "locality": "Valenzuela City, Metro Manila",
    "address": "594 MacArthur Hwy, Valenzuela, 1444 Metro Manila, Philippines",
    "phone": "1622 8952",
    "googlePlaceId": "ChIJXRNRFpazlzMRtTWlRHw61mo",
    "coordinates": null,
    "email": null
  },
  {
    "id": "palingon",
    "name": "Meralco Business Center - Palingon",
    "area": "Metro Manila",
    "locality": "Taguig City, Metro Manila",
    "address": "101 F. Manalo St, Palingon, Taguig, 1630 Metro Manila, Philippines",
    "phone": null,
    "googlePlaceId": "ChIJOQGbaQDHlzMRO3dnza_ldRI",
    "coordinates": null,
    "email": null
  },
  {
    "id": "lucena-branch",
    "name": "Meralco Business Center - Lucena Branch",
    "area": "Quezon",
    "locality": "Lucena City, Quezon",
    "address": "Aurora Blvd, Lucena City, 4301 Quezon, Philippines",
    "phone": "1622 5262",
    "googlePlaceId": "ChIJQVzLb79MvTMRHoa5XBGhyUY",
    "coordinates": null,
    "email": null
  },
  {
    "id": "angono-branch",
    "name": "Meralco Business Center - Angono Branch",
    "area": "Rizal",
    "locality": "Angono, Rizal",
    "address": "M.L. Quezon St, Angono, 1930 Rizal, Philippines",
    "phone": "1622 2646",
    "googlePlaceId": "ChIJkcKb3MDGlzMR_qYkxc8sgfg",
    "coordinates": null,
    "email": null
  },
  {
    "id": "cainta-branch",
    "name": "Meralco Business Center - Cainta Branch",
    "area": "Rizal",
    "locality": "Cainta, Rizal",
    "address": "Ortigas Ave Ext, Sto. Domingo, Cainta, 1900 Rizal, Philippines",
    "phone": "1622 2246",
    "googlePlaceId": "ChIJIULLeIbHlzMRbiYQnmC2Q3k",
    "coordinates": null,
    "email": null
  },
  {
    "id": "tanay-branch",
    "name": "Meralco Business Center - Tanay Branch",
    "area": "Rizal",
    "locality": "Tanay, Rizal",
    "address": "J. Abad Santos St, cor E. Quirino, Tanay, 1920 Rizal, Philippines",
    "phone": "1622 8629",
    "googlePlaceId": "ChIJaVTeE_jrlzMR7x_ddZwzPus",
    "coordinates": null,
    "email": null
  },
  {
    "id": "antipolo-branch",
    "name": "Meralco Business Center - Antipolo Branch",
    "area": "Rizal",
    "locality": "Antipolo City, Rizal",
    "address": "Antipolo, 1870 Rizal, Philippines",
    "phone": null,
    "googlePlaceId": "ChIJIQSODR_BlzMRqnNfDNIwm_4",
    "coordinates": null,
    "email": null
  },
  {
    "id": "rodriguez-branch",
    "name": "Meralco Business Center - Rodriguez Branch",
    "area": "Rizal",
    "locality": "Rodriguez, Rizal",
    "address": "Casa Carmelita Building, E. Rodriguez Highway, Brgy San Jose, Rodriguez, Rizal, Philippines",
    "phone": null,
    "googlePlaceId": "ChIJZ0dnXK27lzMRhLy6VsTLfcA",
    "coordinates": null,
    "email": null
  }
];
