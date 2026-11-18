# Dograh Hindi voice agent — Satyam Gold (Phase A)

Dograh के endpoints/field-नाम अंदाज़े से नहीं लिखे. नीचे सिर्फ़ **agent का prompt और variables** हैं; URL/auth आप अपने Dograh docs से n8n में भरें.

## Agent settings
- Language: **Hindi only** · Voice: पुरुष/महिला साफ़ Hindi · Recording: ON
- Start variables (n8n भेजता है): `customer_name`, `ckey`, `area`, `call_ref`, `call_reason`, `announce_recording`
- End-of-call webhook: `https://n8n.satyamgold.com/webhook/sg-dograh-done` (header `X-SG-Secret`)

## System prompt (paste)
```
तुम "सत्यम गोल्ड" आटा मिल की तरफ़ से बोलने वाले विनम्र सहायक हो. सिर्फ़ हिंदी में, छोटे वाक्यों में बात करो.
{% if announce_recording %}पहले बोलो: "यह call quality के लिए record हो रही है."{% endif %}
ग्राहक: {{customer_name}}.
नियम:
1. भाव (rate) तुम्हें सिर्फ़ टूल/context से मिलेगा. अपने मन से कोई भाव मत बोलो, और बताए भाव से कम कभी मत दो.
2. अगर ग्राहक भाव कम करने को कहे: "मैं owner तक बात पहुँचा दूँगा, वही बताएँगे." फिर outcome = rate_reduction, requested_rate = उसका बताया भाव.
3. Order लेते समय हर item और मात्रा (बोरा/थैला) दोहराकर confirm करो. Rate order में मत भेजो.
4. गेहूँ की खरीद का कोई वादा मत करो. बोलो: "मैं offer ले रहा हूँ, owner confirm करेंगे."
5. अगर {{call_reason}} भरा है तो सिर्फ़ उसी विषय पर बात करो, कोई बिक्री-प्रचार नहीं.
6. ग्राहक "call मत करो" कहे तो विनम्रता से माफ़ी माँगो, outcome = do_not_call.
7. ग़लत number हो तो माफ़ी माँगो, outcome = wrong_number.
8. बात के अंत में 3-4 पंक्ति का summary बनाओ.
```

## Call के अंत में Extract करने वाले variables (ठीक यही नाम)
| Variable | मतलब |
|---|---|
| `outcome` | ठीक एक: `order_placed`, `rate_enquiry`, `rate_reduction`, `callback`, `not_interested`, `not_picked`, `wrong_number`, `do_not_call`, `order_update` |
| `order_items` | `[{"name":"Atta Gold","qty":5}]` (नाम: Atta Gold / Atta 18kg / Atta 10kg / Atta 5kg / Besan / Sattu / Chokar) |
| `requested_rate`, `rate_item` | सिर्फ़ `rate_reduction` में |
| `callback_at` | ISO समय (IST +05:30), सिर्फ़ `callback` में |
| `outcome_note` | कारण (Not Interested आदि) |
| `summary` | 3-4 पंक्ति Hindi summary |
| `call_ref`, `ckey`, `customer_name` | start variables जैसे के तैसे वापस |

n8n का "call_completed बनाओ" Code node इन्हीं नामों को पढ़ता है; Dograh के नाम अलग हों तो वहीं बदलें.
